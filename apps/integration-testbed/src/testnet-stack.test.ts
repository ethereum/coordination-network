import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { bytesToHex, randomBytes } from "@noble/hashes/utils"
import {
    ContractFunctionExecutionError,
    ContractFunctionRevertedError,
    defineChain,
    encodeAbiParameters,
    encodePacked,
    getAddress,
    HttpRequestError,
    keccak256,
    parseEther,
    RpcRequestError,
    toHex,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient
} from "viem"
import { entryPoint08Address } from "viem/account-abstraction"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import type { Chain } from "./anvil"
import { ERC5564_ANNOUNCER_ADDRESS, REPOSITORY_ROOT, SEMAPHORE_ADDRESS, SIMPLE_7702_ACCOUNT_ADDRESS } from "./config"
import { deploymentFileFor, deploymentFilePath } from "./deployment-file"
import { buildMembers, lanAddress, STACK_PORT } from "./members"
import { OperatorError } from "./operator-error"
import { PAYMASTER_GROUP_ABI } from "./paymaster-group"
import { buildStackDescriptor, type ResolvedStack, type StackAddresses } from "./serve"
import { buildStackSecrets } from "./stack-secrets"
import {
    accountKeyOf,
    issuerLeafOf,
    preflight,
    publicRpcOverride,
    REGISTRY_ABI,
    resolveTestnetStack,
    type TestnetStack
} from "./testnet-stack"

const CHAIN_ID = 11155111
const DEPLOY_BLOCK = 100n
const GROUP_ID = 7n
const PAYMASTER_GROUP_ID = 9n
const WINDOW = 10_000n

const ADDRESSES: StackAddresses = {
    identityRegistry: "0x1000000000000000000000000000000000000001",
    announcer: "0x1000000000000000000000000000000000000002",
    revocation: "0x1000000000000000000000000000000000000003",
    credentialRevocationRegistry: "0x100000000000000000000000000000000000000d",
    credentialRevocationRegistryId: 0n,
    semaphore: "0x1000000000000000000000000000000000000004",
    networkMemberRegistry: "0x1000000000000000000000000000000000000005",
    networkMemberGroup: "0x1000000000000000000000000000000000000006",
    networkMemberGovernance: "0x1000000000000000000000000000000000000007",
    approvedIssuerSet: "0x1000000000000000000000000000000000000008",
    governanceSafe: "0x1000000000000000000000000000000000000009",
    entryPoint: "0x100000000000000000000000000000000000000a",
    paymaster: "0x100000000000000000000000000000000000000b",
    accountImplementation: "0x100000000000000000000000000000000000000c"
}

const SEEDS = [randomBytes(32), randomBytes(32), randomBytes(32)]
const MEMBERS = buildMembers(SEEDS, 11155111)
const OWNER_KEY = generatePrivateKey()
const OWNER = privateKeyToAccount(OWNER_KEY)
const BUNDLER_KEY = generatePrivateKey()
const BUNDLER = privateKeyToAccount(BUNDLER_KEY)
/** The founding member the runbook's deploy admits, seated at OWNER; its secret is not the stack's. */
const FOUNDING_MEMBER_ID: Hex = `0x${"0f".repeat(32)}`
const OTHER_ADDRESS = getAddress("0x2000000000000000000000000000000000000002")

function addressesOf(stack: ResolvedStack): Address[] {
    return Object.values(stack.addresses).filter((value): value is Address => typeof value === "string")
}

interface World {
    rpcChainId: number
    /** Addresses with no code. */
    codeless: Set<Address>
    moduleEnabled: boolean
    wiredIssuerSet: Address
    owners: Address[]
    threshold: bigint
    approved: Set<string>
    /** What the registry holds as each approved member's governance signer. */
    signers: Map<string, Address>
    inGroup: Set<bigint>
    inPaymasterGroup: Set<bigint>
    /** Members whose own signing key is published. */
    issuerKeys: Set<string>
    /** Members with only some other keys published, by count. */
    otherKeys: Map<string, number>
    balances: Map<Address, bigint>
    deposit: bigint
    logsError?: string
    logsFailure?: Error
    paymasterGroupAdmin: Address
    /** How the registry answers `memberNetworkIdOf`. */
    registry: "derives" | "reverts" | { returns: Hex }
    /** The `GovernanceSignerPublished` events the registry has emitted: both admission paths emit one. */
    published: { memberNetworkId: Hex; governanceSigner: Address }[]
    /** The block every published signer log sits in. */
    publishedBlock: bigint
    logRequests: { address?: Address; fromBlock?: bigint; toBlock?: bigint }[]
    head: bigint
}

/** A network the runbook deployed and genesis then set up: Safe [OWNER, Member A, Member B] at threshold 2. */
function healthyWorld(stack: TestnetStack): World {
    const founders = stack.members.filter((member) => member.role === "founder")
    const balances = new Map<Address, bigint>([
        [OWNER.address, parseEther("1")],
        [BUNDLER.address, parseEther("1")]
    ])
    for (const member of stack.members) {
        balances.set(member.authAddress, parseEther("0.05"))
        balances.set(member.governanceSignerAddress, parseEther("0.05"))
    }

    return {
        rpcChainId: CHAIN_ID,
        codeless: new Set(),
        moduleEnabled: true,
        wiredIssuerSet: stack.addresses.approvedIssuerSet,
        owners: [OWNER.address, ...founders.map((member) => member.governanceSignerAddress)],
        threshold: 2n,
        approved: new Set([FOUNDING_MEMBER_ID, ...founders.map((member) => member.networkId)]),
        signers: new Map([
            [FOUNDING_MEMBER_ID, OWNER.address],
            ...founders.map((member) => [member.networkId, member.governanceSignerAddress] as const)
        ]),
        inGroup: new Set(founders.map((member) => member.semaphoreCommitment)),
        inPaymasterGroup: new Set(founders.map((member) => member.semaphoreCommitment)),
        issuerKeys: new Set(founders.map((member) => member.networkId)),
        otherKeys: new Map(),
        balances,
        deposit: parseEther("0.05"),
        paymasterGroupAdmin: OWNER.address,
        registry: "derives",
        published: [{ memberNetworkId: FOUNDING_MEMBER_ID, governanceSigner: OWNER.address }],
        publishedBlock: DEPLOY_BLOCK + 1n,
        logRequests: [],
        head: DEPLOY_BLOCK + 2n * WINDOW
    }
}

/** What an eth_call to `memberNetworkIdOf` on a contract without it does: the node answers a revert. */
function revertedCall(functionName: string): Error {
    const reverted = new ContractFunctionRevertedError({
        abi: REGISTRY_ABI,
        functionName,
        message: "execution reverted"
    })
    return new ContractFunctionExecutionError(reverted, { abi: REGISTRY_ABI, functionName, args: [0n, 0n] })
}

function fakeClient(world: World): PublicClient {
    const client = {
        getChainId: async () => world.rpcChainId,
        getBlockNumber: async () => world.head,
        getCode: async ({ address }: { address: Address }) => (world.codeless.has(address) ? undefined : "0x60"),
        getBalance: async ({ address }: { address: Address }) => world.balances.get(address) ?? 0n,
        getLogs: async (request: {
            address?: Address
            event?: unknown
            args?: { governanceSigner?: Address }
            fromBlock?: bigint
            toBlock?: bigint
        }) => {
            if ("event" in request) {
                const inRange =
                    request.address === ADDRESSES.networkMemberRegistry &&
                    world.publishedBlock >= (request.fromBlock ?? 0n) &&
                    world.publishedBlock <= (request.toBlock ?? world.head)
                return inRange
                    ? world.published
                          .filter((args) => args.governanceSigner === request.args?.governanceSigner)
                          .map((args) => ({ args }))
                    : []
            }
            world.logRequests.push(request)
            if (world.logsFailure) throw world.logsFailure
            if (world.logsError) throw new Error(world.logsError)
            return []
        },
        readContract: async ({
            address,
            functionName,
            args
        }: {
            address: Address
            functionName: string
            args?: readonly unknown[]
        }) => {
            switch (functionName) {
                case "getOwners":
                    return world.owners
                case "getThreshold":
                    return world.threshold
                case "isModuleEnabled":
                    return world.moduleEnabled
                case "approvedIssuerSet":
                    return world.wiredIssuerSet
                case "memberNetworkIdOf": {
                    if (world.registry === "reverts") throw revertedCall(functionName)
                    if (typeof world.registry === "object") return world.registry.returns
                    const [x, y] = args as [bigint, bigint]
                    return keccak256(encodePacked(["uint256", "uint256"], [x, y]))
                }
                case "isApproved":
                    return world.approved.has(String(args?.[0]))
                case "governanceSignerOf":
                    return world.signers.get(String(args?.[0])) ?? `0x${"00".repeat(20)}`
                case "GROUP_ID":
                    return address === ADDRESSES.paymaster ? PAYMASTER_GROUP_ID : GROUP_ID
                case "hasMember": {
                    const [groupId, commitment] = args as [bigint, bigint]
                    const group = groupId === PAYMASTER_GROUP_ID ? world.inPaymasterGroup : world.inGroup
                    return group.has(commitment)
                }
                case "issuerKeysOf": {
                    const networkId = String(args?.[0])
                    const others = Array.from({ length: world.otherKeys.get(networkId) ?? 0 }, (_, index) =>
                        BigInt(index + 1)
                    )
                    const member = MEMBERS.find((candidate) => candidate.networkId === networkId)
                    return world.issuerKeys.has(networkId) && member ? [...others, await issuerLeafOf(member)] : others
                }
                case "getDeposit":
                    return world.deposit
                case "getGroupAdmin":
                    return world.paymasterGroupAdmin
                default:
                    throw new Error(`unexpected read ${functionName}`)
            }
        }
    }
    return client as unknown as PublicClient
}

function fakeStack(): TestnetStack {
    const chainDefinition = defineChain({
        id: CHAIN_ID,
        name: "sepolia",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: ["http://rpc.test"] } }
    })
    const chain: Chain = {
        chainDefinition,
        deployer: OWNER.address,
        signer: OWNER,
        publicClient: {} as PublicClient,
        rpcUrl: "http://rpc.test",
        blockScanWindowSize: 10n,
        stop: () => {},
        walletClient: {} as WalletClient
    }
    return {
        chain,
        addresses: ADDRESSES,
        deployBlock: DEPLOY_BLOCK,
        groupId: GROUP_ID,
        safeVersion: "1.4.1",
        chainId: CHAIN_ID,
        members: buildMembers(SEEDS, 11155111),
        logWindowBlocks: Number(WINDOW),
        logConfirmations: 2,
        publicRpcUrl: "http://127.0.0.1:8545",
        paymasterMirror: {
            paymaster: { abi: PAYMASTER_GROUP_ABI, address: ADDRESSES.paymaster },
            group: { abi: [], address: ADDRESSES.networkMemberGroup },
            paymasterGroupFromBlock: DEPLOY_BLOCK,
            pollingIntervalMs: 12_000
        },
        bundlerAccount: BUNDLER
    }
}

/** The world a fresh `deployAndConfigureAll` leaves: Safe [OWNER] at threshold 1, nobody else in. */
function deployedWorld(stack: TestnetStack): World {
    const world = healthyWorld(stack)
    for (const founder of stack.members.filter((member) => member.role === "founder")) {
        world.approved.delete(founder.networkId)
        world.signers.delete(founder.networkId)
        world.inGroup.delete(founder.semaphoreCommitment)
        world.inPaymasterGroup.delete(founder.semaphoreCommitment)
        world.issuerKeys.delete(founder.networkId)
    }
    world.owners = [OWNER.address]
    world.threshold = 1n
    world.balances = new Map([[OWNER.address, parseEther("1")]])
    world.deposit = 0n
    return world
}

/** Safe [OWNER, Member A, Member B] at threshold 2, with Member B's admission still to make. */
function pendingWorld(stack: TestnetStack): World {
    const world = healthyWorld(stack)
    world.approved.delete(stack.members[1].networkId)
    return world
}

const heldKeysOf = (stack: TestnetStack): Address[] => [
    OWNER.address,
    ...stack.members
        .filter((member) => member.role === "founder")
        .flatMap((member) => [member.governanceSignerAddress, member.authAddress])
]

async function failuresOf(
    world: (stack: TestnetStack) => World,
    scope: "serve" | "genesis" = "serve",
    heldAddresses?: (stack: TestnetStack) => Address[]
) {
    const stack = fakeStack()
    try {
        const { warnings } = await preflight(stack, fakeClient(world(stack)), scope, heldAddresses?.(stack))
        return { lines: [], warnings }
    } catch (error) {
        assert.ok(error instanceof OperatorError, `expected an OperatorError, got ${String(error)}`)
        return { lines: error.message.split("\n"), warnings: [] }
    }
}

function oneFailure(lines: string[], pattern: RegExp): void {
    assert.equal(lines.length, 1, lines.join("\n"))
    assert.match(lines[0], pattern)
}

function someLine(lines: string[], pattern: RegExp): void {
    assert.ok(
        lines.some((line) => pattern.test(line)),
        lines.join("\n")
    )
}

test("buildMembers gives Member A and Member B the founder role and Member C the candidate's", () => {
    assert.deepEqual(
        buildMembers(SEEDS, 11155111).map((member) => [member.name, member.role]),
        [
            ["Member A", "founder"],
            ["Member B", "founder"],
            ["Member C", "candidate"]
        ]
    )
})

test("buildMembers derives the same members from the same seeds, each with its own credential signer", async () => {
    const first = buildMembers(SEEDS, 11155111)
    const second = buildMembers(SEEDS, 11155111)

    assert.deepEqual(
        second.map((member) => [member.networkId, member.governanceSignerAddress, member.walletPrivateKey]),
        first.map((member) => [member.networkId, member.governanceSignerAddress, member.walletPrivateKey])
    )
    const keys = await Promise.all(first.map((member) => member.signer.getPublicKey()))
    assert.deepEqual(await Promise.all(second.map((member) => member.signer.getPublicKey())), keys)
    assert.notDeepEqual(keys[0], keys[1])
})

test("accountKeyOf names the id the stack gives the member", () => {
    for (const member of MEMBERS) assert.equal(accountKeyOf(member).memberNetworkId, member.networkId)
})

test("the descriptor built from a testnet stack's members carries no secret", () => {
    const stack = fakeStack()
    const secrets = buildStackSecrets(stack.members)
    const descriptor = buildStackDescriptor(
        "127.0.0.1",
        { rpcUrl: stack.publicRpcUrl, chainId: stack.chainId },
        stack.addresses,
        stack.members
    )
    const json = JSON.stringify(descriptor, (_key, value) => (typeof value === "bigint" ? value.toString() : value))

    assert.equal(stack.members.length > 0, true)
    for (const token of Object.values(secrets.memberServerTokens)) assert.equal(json.includes(token), false)
    assert.equal(json.includes(secrets.dashboardKey), false)
    for (const member of descriptor.members) assert.equal("memberServerToken" in member, false)
})

test("preflight passes a network that is set up, with nothing to warn about", async () => {
    assert.deepEqual(await failuresOf(healthyWorld), { lines: [], warnings: [] })
})

test("preflight names a chain id that differs from the deployment file's", async () => {
    const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), rpcChainId: 1 }))

    oneFailure(lines, /chain id.*1.*11155111/)
})

test("preflight names every address that has no code", async () => {
    const stack = fakeStack()
    const { lines } = await failuresOf((built) => ({
        ...healthyWorld(built),
        codeless: new Set(addressesOf(stack))
    }))

    assert.equal(lines.filter((line) => /no contract code/.test(line)).length, addressesOf(stack).length)
})

test("preflight tells a deployment older than the account-key contracts to point DEPLOYMENT_FILE at this branch's", async () => {
    for (const scope of ["serve", "genesis"] as const) {
        const { lines } = await failuresOf(
            (stack) => ({ ...healthyWorld(stack), registry: "reverts" }),
            scope,
            heldKeysOf
        )

        oneFailure(
            lines,
            /^registry 0x1000000000000000000000000000000000000005 has no memberNetworkIdOf: deployment predates the account-key contracts, point DEPLOYMENT_FILE at a deployment of this branch$/
        )
    }
})

test("preflight does not call a failed request a stale deployment", async () => {
    const stack = fakeStack()
    const client = fakeClient(healthyWorld(stack))
    const read = client.readContract
    client.readContract = (async (parameters: { functionName: string }) => {
        if (parameters.functionName === "memberNetworkIdOf") throw new Error("connection reset")
        return read(parameters as never)
    }) as typeof client.readContract

    const lines = await preflightLines(stack, client)

    assert.deepEqual(lines, ["registry: connection reset"])
})

test("preflight names a registry that derives another id from a founder's account key", async () => {
    const { lines } = await failuresOf((stack) => ({
        ...healthyWorld(stack),
        registry: { returns: `0x${"ab".repeat(32)}` }
    }))

    assert.equal(lines.length, 2, lines.join("\n"))
    assert.match(lines[0], /derives 0xabab.* from Member A's account key, the stack's networkId for it is 0x/)
    assert.match(lines[1], /Member B's account key/)
})

test("preflight names a Safe without the governance module enabled, and how to fix it", async () => {
    const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), moduleEnabled: false }))

    oneFailure(lines, /module.*not enabled; run ConfigureGovernance \(deployAndConfigureAll does\)/)
})

test("preflight names a registry wired to another issuer set", async () => {
    const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), wiredIssuerSet: OTHER_ADDRESS }))

    oneFailure(lines, /approvedIssuerSet.*run ConfigureGovernance/)
})

test("preflight names a founder the registry has not approved", async () => {
    const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), approved: new Set() }))

    assert.equal(lines.length, 2)
    assert.match(lines[0], /Member A.*not approved/)
    assert.match(lines[1], /Member B.*not approved/)
})

test("preflight names a founder missing from the approved-member group", async () => {
    const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), inGroup: new Set() }))

    assert.equal(lines.length, 2)
    assert.match(lines[0], /Member A.*approved-member group/)
})

test("preflight warns that the mirror adds a founder missing from the paymaster group at start", async () => {
    const { lines, warnings } = await failuresOf((stack) => ({ ...healthyWorld(stack), inPaymasterGroup: new Set() }))

    assert.deepEqual(lines, [])
    assert.equal(warnings.length, 2)
    assert.match(warnings[0], /Member A.*paymaster group; the mirror adds it at start/)
})

test("preflight names a founder whose governance signer is not a Safe owner", async () => {
    const { lines } = await failuresOf((stack) => ({
        ...healthyWorld(stack),
        owners: [OWNER.address, stack.members[0].governanceSignerAddress],
        threshold: 2n
    }))

    oneFailure(
        lines,
        /Member B.*governance signer.*not a Safe owner; its seat was removed through the Safe, and genesis cannot restore it/
    )
})

test("preflight tells an unapproved founder without a seat to run genesis", async () => {
    const { lines } = await failuresOf((stack) => ({
        ...pendingWorld(stack),
        owners: [OWNER.address, stack.members[0].governanceSignerAddress],
        threshold: 2n
    }))

    someLine(lines, /Member B.*governance signer.*not a Safe owner; run genesis to seat it/)
})

test("preflight names a founder whose registered governance signer is not the one derived from its seed", async () => {
    for (const scope of ["serve", "genesis"] as const) {
        const { lines } = await failuresOf((stack) => {
            const world = healthyWorld(stack)
            world.signers.set(stack.members[1].networkId, OTHER_ADDRESS)
            return world
        }, scope)

        someLine(
            lines,
            /^Member B: the registry's governance signer is 0x2000.*derived from its seed.*founding member's secret/
        )
    }
})

test("preflight names a founder with no issuer key published", async () => {
    const { lines } = await failuresOf((stack) => ({
        ...healthyWorld(stack),
        issuerKeys: new Set([stack.members[0].networkId])
    }))

    oneFailure(lines, /Member B.*no issuer key published; run yarn stack:genesis to publish it$/)
})

test("preflight names a founder whose published issuer key is not its own", async () => {
    const { lines } = await failuresOf((stack) => ({
        ...healthyWorld(stack),
        issuerKeys: new Set([stack.members[0].networkId]),
        otherKeys: new Map([[stack.members[1].networkId, 1]])
    }))

    oneFailure(
        lines,
        /Member B.*1 issuer key\(s\) published, none is the signing key derived from its seed; run yarn stack:genesis to publish it$/
    )
})

test("preflight names a Safe threshold that is not the governance rule's, exactly", async () => {
    const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), threshold: 1n }))

    assert.deepEqual(lines, [
        `Safe ${ADDRESSES.governanceSafe}: threshold is 1 for 3 owner(s), the governance rule gives 2; the owners restore it with the Safe's changeThreshold`
    ])
})

test("preflight names each balance below its floor", async () => {
    const { lines } = await failuresOf((stack) => {
        const world = healthyWorld(stack)
        world.balances.set(stack.members[2].authAddress, 0n)
        world.balances.set(stack.members[0].governanceSignerAddress, 0n)
        world.balances.set(BUNDLER.address, parseEther("0.01"))
        world.balances.set(OWNER.address, 0n)
        return { ...world, deposit: parseEther("0.001") }
    })

    assert.equal(lines.length, 5, lines.join("\n"))
    for (const pattern of [/Member C auth/, /Member A governance signer/, /bundler/, /OWNER/, /paymaster deposit/]) {
        assert.ok(
            lines.some((line) => pattern.test(line) && /below/.test(line)),
            `no line for ${pattern}`
        )
    }
    // Genesis refills everything but OWNER, which is what funds it.
    for (const line of lines) {
        assert.equal(line.endsWith("; run yarn stack:genesis to refill"), !/^OWNER/.test(line), line)
    }
})

test("preflight names a provider that refuses the log window", async () => {
    const { lines } = await failuresOf((stack) => ({
        ...healthyWorld(stack),
        logsError: "query exceeds max block range 10"
    }))

    oneFailure(lines, /eth_getLogs.*10000 blocks.*max block range/)
})

test("preflight carries the provider's own words and the HTTP status of a refused read, without the keyed URL", async () => {
    const keyed = "https://eth-sepolia.example.io/v2/SECRETKEY"
    const rpc = new RpcRequestError({
        body: {},
        url: keyed,
        error: { code: -32000, message: "query exceeds max block range 1000" }
    })
    const http = new HttpRequestError({ body: {}, url: keyed, status: 429, details: "rate limited" })

    for (const [failure, expected] of [
        [rpc, /max block range 1000/],
        [http, /HTTP 429.*rate limited/]
    ] as const) {
        const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), logsFailure: failure }))

        oneFailure(lines, /eth_getLogs.*refused/)
        assert.match(lines[0], expected)
        assert.ok(!lines[0].includes("SECRETKEY"), lines[0])
    }
})

test("preflight reports every failure at once, one line each", async () => {
    const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), moduleEnabled: false, threshold: 1n }))

    assert.equal(lines.length, 2)
})

test("a candidate the registry already approved is a warning, not a failure", async () => {
    const { lines, warnings } = await failuresOf((stack) => {
        const world = healthyWorld(stack)
        world.approved.add(stack.members[2].networkId)
        world.signers.set(stack.members[2].networkId, stack.members[2].governanceSignerAddress)
        world.owners = [stack.members[2].governanceSignerAddress, ...world.owners]
        world.threshold = 3n
        return world
    })

    assert.deepEqual(lines, [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Member C.*already approved/)
})

test("the serve scope counts the stack's distinct seats toward the threshold, and words a shortfall by what is missing", async () => {
    const short = await failuresOf((stack) => ({
        ...healthyWorld(stack),
        owners: [OTHER_ADDRESS, OWNER.address, ...healthyWorld(stack).owners],
        threshold: 3n
    }))
    assert.deepEqual(short.lines, [])
    assert.deepEqual(short.warnings, [
        "the stack's members own 2 of the 3 approvals the Safe needs; the Safe's other owners must approve, so admissions are beyond the stack"
    ])

    const stack = fakeStack()
    const [memberA, memberB] = stack.members
    stack.members[1] = { ...memberB, governanceSignerAddress: memberA.governanceSignerAddress }
    const world = { ...healthyWorld(stack), owners: [OWNER.address, memberA.governanceSignerAddress], threshold: 2n }
    world.signers.set(memberB.networkId, memberA.governanceSignerAddress)
    const { warnings } = await preflight(stack, fakeClient(world), "serve")
    assert.match(warnings[0], /the stack's members own 1 of the 2 approvals the Safe needs/)
})

test("a grown network serves with a warning: 7 owners at threshold 4", async () => {
    const { lines, warnings } = await failuresOf((stack) => ({
        ...healthyWorld(stack),
        owners: [
            ...[3, 4, 5, 6].map((index) => getAddress(`0x${index.toString().repeat(40)}`)),
            ...healthyWorld(stack).owners
        ],
        threshold: 4n
    }))

    assert.deepEqual(lines, [])
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /the stack's members own 2 of the 4 approvals the Safe needs/)
})

test("the genesis scope has nothing to sign once every founder is admitted, so a grown Safe passes", async () => {
    const { lines } = await failuresOf(
        (stack) => ({
            ...healthyWorld(stack),
            owners: [
                ...[3, 4, 5, 6].map((index) => getAddress(`0x${index.toString().repeat(40)}`)),
                ...healthyWorld(stack).owners
            ],
            threshold: 4n
        }),
        "genesis",
        (stack) => [OWNER.address, stack.members[0].governanceSignerAddress]
    )

    assert.deepEqual(lines, [])
})

test("the serve scope accepts the Safe after the candidate's admission", async () => {
    const { lines, warnings } = await failuresOf((stack) => {
        const world = healthyWorld(stack)
        world.approved.add(stack.members[2].networkId)
        world.signers.set(stack.members[2].networkId, stack.members[2].governanceSignerAddress)
        return {
            ...world,
            owners: [stack.members[2].governanceSignerAddress, ...world.owners],
            threshold: 3n
        }
    })

    assert.deepEqual(lines, [])
    assert.match(warnings[0], /Member C.*already approved/)
})

test("the serve scope refuses a network genesis has not set up, one line per gap", async () => {
    const { lines } = await failuresOf(deployedWorld)

    someLine(lines, /Member A.*not approved/)
    someLine(lines, /Member B.*not approved/)
    someLine(lines, /Member A.*governance signer.*not a Safe owner/)
    someLine(lines, /Member A.*not a Safe owner; run genesis to seat it/)
})

test("both scopes name a paymaster group whose admin is not OWNER", async () => {
    const world = (stack: TestnetStack) => ({ ...healthyWorld(stack), paymasterGroupAdmin: OTHER_ADDRESS })

    oneFailure((await failuresOf(world, "serve")).lines, /paymaster group 9 admin is 0x2000.*OWNER is 0x/)
    oneFailure((await failuresOf(world, "genesis", heldKeysOf)).lines, /paymaster group \d+ admin is 0x2000/)
})

test("the genesis scope passes a fresh deployment and asks nothing about the founders yet", async () => {
    const { lines } = await failuresOf(
        (stack) => ({ ...deployedWorld(stack), balances: new Map([[OWNER.address, parseEther("1")]]) }),
        "genesis",
        heldKeysOf
    )

    assert.deepEqual(lines, [])
})

test("the genesis scope still runs the chain id, code, module, wiring and log window checks", async () => {
    const stack = fakeStack()
    const { lines } = await failuresOf(
        (built) => ({
            ...deployedWorld(built),
            rpcChainId: 1,
            codeless: new Set([stack.addresses.announcer]),
            moduleEnabled: false,
            wiredIssuerSet: OTHER_ADDRESS,
            logsError: "refused"
        }),
        "genesis",
        heldKeysOf
    )

    for (const pattern of [/chain id/, /no contract code at announcer/, /module/, /approvedIssuerSet/, /eth_getLogs/]) {
        someLine(lines, pattern)
    }
    assert.equal(lines.length, 5, lines.join("\n"))
})

test("the genesis scope asks OWNER for the whole of a fresh network's top-ups plus the gas margin", async () => {
    const fresh = (balance: string) => (stack: TestnetStack) => {
        const world = deployedWorld(stack)
        world.balances = new Map([[OWNER.address, parseEther(balance)]])
        return world
    }

    // Three auth accounts and two governance signers at 0.05, the bundler at 0.2, the deposit at 0.05, and 0.05 for gas.
    oneFailure(
        (await failuresOf(fresh("0.54"), "genesis", heldKeysOf)).lines,
        /OWNER.*below the 0\.55 ETH this run needs/
    )
    assert.deepEqual((await failuresOf(fresh("0.55"), "genesis", heldKeysOf)).lines, [])
})

test("the genesis scope asks a fully funded network's OWNER for the gas margin only, so a resume can run", async () => {
    const funded = (balance: string) => (stack: TestnetStack) => {
        const world = healthyWorld(stack)
        world.balances.set(BUNDLER.address, parseEther("0.2"))
        world.balances.set(OWNER.address, parseEther(balance))
        return world
    }

    oneFailure(
        (await failuresOf(funded("0.04"), "genesis", heldKeysOf)).lines,
        /OWNER.*below the 0\.05 ETH this run needs/
    )
    assert.deepEqual((await failuresOf(funded("0.05"), "genesis", heldKeysOf)).lines, [])
    assert.deepEqual((await failuresOf(funded("0.011"), "serve")).lines, [])
})

test("the genesis scope asks the held keys to reach the Safe's threshold, naming both numbers, while an admission is pending", async () => {
    const { lines } = await failuresOf(
        (stack) => {
            const world = healthyWorld(stack)
            world.approved.delete(stack.members[1].networkId)
            return {
                ...world,
                owners: [OTHER_ADDRESS, OWNER.address, stack.members[0].governanceSignerAddress],
                threshold: 2n
            }
        },
        "genesis",
        (stack) => [OWNER.address, stack.members[1].governanceSignerAddress]
    )

    oneFailure(lines, /the Safe needs 2 approvals and the held keys own 1 of its 3 seat\(s\)/)
})

test("the genesis scope names an OWNER that is no approved member's governance signer", async () => {
    const { lines } = await failuresOf(
        (stack) => ({ ...pendingWorld(stack), published: [], balances: pendingWorld(stack).balances }),
        "genesis",
        heldKeysOf
    )
    oneFailure(
        lines,
        /OWNER 0x[0-9a-fA-F]{40} is no approved member's governance signer; deploy with deployAndConfigureAll/
    )

    const removed = await failuresOf(
        (stack) => {
            const world = pendingWorld(stack)
            world.approved.delete(FOUNDING_MEMBER_ID)
            return world
        },
        "genesis",
        heldKeysOf
    )
    oneFailure(removed.lines, /no approved member's governance signer/)

    const reseated = await failuresOf(
        (stack) => {
            const world = pendingWorld(stack)
            world.signers.set(FOUNDING_MEMBER_ID, OTHER_ADDRESS)
            return world
        },
        "genesis",
        heldKeysOf
    )
    oneFailure(reseated.lines, /no approved member's governance signer/)
})

test("the genesis scope does not ask for OWNER's seat once every founder is admitted", async () => {
    const { lines } = await failuresOf((stack) => ({ ...healthyWorld(stack), published: [] }), "genesis", heldKeysOf)

    assert.deepEqual(lines, [])
})

test("the genesis scope finds OWNER's member among the registry's signer logs, however it was admitted", async () => {
    // A member admitted through the governance contract publishes its signer the same way the
    // runbook's founding member does, so one log per member; only OWNER's is looked for.
    const { lines } = await failuresOf(
        (stack) => ({
            ...pendingWorld(stack),
            published: [
                {
                    memberNetworkId: stack.members[0].networkId,
                    governanceSigner: stack.members[0].governanceSignerAddress
                },
                { memberNetworkId: FOUNDING_MEMBER_ID, governanceSigner: OWNER.address }
            ]
        }),
        "genesis",
        heldKeysOf
    )

    assert.deepEqual(lines, [])
})

test("the genesis scope names a founder at the issuer-key cap without its own key", async () => {
    const { lines } = await failuresOf(
        (stack) => ({
            ...deployedWorld(stack),
            otherKeys: new Map([[stack.members[1].networkId, 8]])
        }),
        "genesis",
        heldKeysOf
    )

    oneFailure(lines, /^Member B already has 8 issuer keys published and none is the one derived from its seed/)
})

test("the genesis scope lets a founder at the cap through when its own key is among them", async () => {
    const { lines } = await failuresOf(
        (stack) => ({
            ...healthyWorld(stack),
            otherKeys: new Map([[stack.members[1].networkId, 7]]),
            balances: new Map([[OWNER.address, parseEther("1")]]),
            deposit: parseEther("0.05")
        }),
        "genesis",
        heldKeysOf
    )

    assert.deepEqual(
        lines.filter((line) => /issuer keys/.test(line)),
        []
    )
})

test("preflight turns a read that throws into a line and still reports the others", async () => {
    const stack = fakeStack()
    const client = fakeClient({ ...healthyWorld(stack), moduleEnabled: false })
    client.getBalance = async () => {
        throw new Error("connection reset\n    at fetch (node:internal)")
    }

    const lines = await preflightLines(stack, client)

    assert.ok(lines.includes("OWNER: connection reset"), lines.join("\n"))
    someLine(lines, /module.*not enabled/)
    assert.ok(
        lines.every((line) => !line.includes("node:internal")),
        "only the first line of the error is kept"
    )
})

test("preflight turns a failed Safe owners read into a line without dropping the founders' checks", async () => {
    const stack = fakeStack()
    const client = fakeClient({ ...healthyWorld(stack), approved: new Set<string>() })
    const read = client.readContract
    client.readContract = (async (parameters: { functionName: string }) => {
        if (parameters.functionName === "getOwners") throw new Error("execution reverted")
        return read(parameters as never)
    }) as typeof client.readContract

    const lines = await preflightLines(stack, client)

    assert.ok(lines.includes("Safe owners: execution reverted"), lines.join("\n"))
    assert.equal(lines.filter((line) => /not approved on the registry/.test(line)).length, 2)
})

async function preflightLines(stack: TestnetStack, client: PublicClient): Promise<string[]> {
    try {
        await preflight(stack, client, "serve")
    } catch (error) {
        return (error as Error).message.split("\n")
    }
    return []
}

test("the preflight log probe asks for exactly the window from the deploy block", async () => {
    const stack = fakeStack()
    const world = healthyWorld(stack)

    await preflight(stack, fakeClient(world), "serve")

    assert.deepEqual(world.logRequests, [
        { address: ADDRESSES.networkMemberRegistry, fromBlock: DEPLOY_BLOCK, toBlock: DEPLOY_BLOCK + WINDOW - 1n }
    ])
})

test("the preflight log probe stops at the head when the window reaches past it", async () => {
    const stack = fakeStack()
    const world = { ...healthyWorld(stack), head: DEPLOY_BLOCK + 50n }

    await preflight(stack, fakeClient(world), "serve")

    assert.equal(world.logRequests[0].toBlock, DEPLOY_BLOCK + 50n)
})

const DEPLOYED_CHAIN_ID = 424242
const DEPLOYED = {
    blockNumber: 123,
    chainId: DEPLOYED_CHAIN_ID,
    governanceSafe: ADDRESSES.governanceSafe,
    networkMemberGovernance: ADDRESSES.networkMemberGovernance,
    networkMemberGroup: ADDRESSES.networkMemberGroup,
    networkMemberGroupId: 5,
    networkMemberRegistry: ADDRESSES.networkMemberRegistry,
    identityRegistry: ADDRESSES.identityRegistry,
    approvedIssuerSet: ADDRESSES.approvedIssuerSet,
    semaphorePaymaster: ADDRESSES.paymaster,
    revocation: ADDRESSES.revocation,
    credentialRevocationRegistry: ADDRESSES.credentialRevocationRegistry,
    credentialRevocationRegistryId: 0
}

/** Answers the three reads `resolveTestnetStack` makes of a provider, on a local socket. */
async function startFakeRpc(): Promise<{ url: string; close(): Promise<void> }> {
    const answer = (call: { method: string }): string => {
        switch (call.method) {
            case "eth_chainId":
                return toHex(DEPLOYED_CHAIN_ID)
            case "eth_getBalance":
                return "0x0"
            case "eth_call":
                return encodeAbiParameters([{ type: "string" }], ["1.4.1"])
            default:
                throw new Error(`unexpected ${call.method}`)
        }
    }
    const server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
            const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string }
            response.writeHead(200, { "content-type": "application/json" })
            response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result: answer(call) }))
        })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve())
                server.closeAllConnections()
            })
    }
}

const ENV_KEYS = [
    "STACK_MEMBER_SEEDS",
    "RPC_URL",
    "OWNER_PRIVATE_KEY",
    "DEPLOYMENT_FILE",
    "STACK_LOG_WINDOW_BLOCKS",
    "STACK_BUNDLER_PRIVATE_KEY",
    "STACK_PUBLIC_RPC_URL",
    "STACK_HOST",
    "TESTBED_MODE"
] as const

/** Runs `run` against a fake provider, with exactly these variables set and the rest cleared. */
async function withTestnetEnvironment<T>(
    overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>,
    run: () => Promise<T>
): Promise<T> {
    const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const)
    const rpc = await startFakeRpc()
    for (const key of ENV_KEYS) delete process.env[key]
    Object.assign(process.env, {
        STACK_MEMBER_SEEDS: SEEDS.map((seed) => bytesToHex(seed)).join(","),
        RPC_URL: rpc.url,
        OWNER_PRIVATE_KEY: OWNER_KEY,
        STACK_BUNDLER_PRIVATE_KEY: BUNDLER_KEY,
        ...overrides
    })
    try {
        return await run()
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
        await rpc.close()
    }
}

function writeDeployment(overrides: Partial<typeof DEPLOYED> = {}): { file: string; remove(): void } {
    const directory = mkdtempSync(join(tmpdir(), "testnet-stack-"))
    const file = join(directory, "deployment.json")
    writeFileSync(file, JSON.stringify({ ...DEPLOYED, ...overrides }))
    return { file, remove: () => rmSync(directory, { recursive: true, force: true }) }
}

/** Runs `run` with a deployment file and the fake provider in place. */
async function withDeployment<T>(
    overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>,
    run: () => Promise<T>
): Promise<T> {
    const deployment = writeDeployment()
    try {
        return await withTestnetEnvironment({ DEPLOYMENT_FILE: deployment.file, ...overrides }, run)
    } finally {
        deployment.remove()
    }
}

test("resolveTestnetStack refuses to start without member seeds, before it touches the network", async () => {
    await withTestnetEnvironment({ STACK_MEMBER_SEEDS: "  " }, async () => {
        await assert.rejects(
            resolveTestnetStack(() => {}),
            (error: unknown) => error instanceof OperatorError && /^STACK_MEMBER_SEEDS must be set/.test(error.message)
        )
    })
})

test("resolveTestnetStack refuses to start without a bundler key, before it touches the network", async () => {
    await withTestnetEnvironment({ STACK_BUNDLER_PRIVATE_KEY: "", RPC_URL: "" }, async () => {
        await assert.rejects(
            resolveTestnetStack(() => {}),
            (error: unknown) =>
                error instanceof OperatorError &&
                /^STACK_BUNDLER_PRIVATE_KEY must be set in testnet mode/.test(error.message)
        )
    })
})

test("resolveTestnetStack reads the seeds and the bundler key before the RPC_URL", async () => {
    await withTestnetEnvironment({ RPC_URL: "" }, async () => {
        await assert.rejects(
            resolveTestnetStack(() => {}),
            (error: unknown) => error instanceof OperatorError && /^RPC_URL must be set/.test(error.message)
        )
    })
})

test("resolveTestnetStack never reports the path or query of a keyed RPC_URL", async () => {
    await withDeployment({}, async () => {
        process.env.RPC_URL = `${process.env.RPC_URL}/v2/SECRETKEY?apikey=SECRETKEY`
        const reported: string[] = []

        await resolveTestnetStack((message) => reported.push(message))

        assert.ok(reported.length > 0)
        assert.ok(!reported.join("\n").includes("SECRETKEY"))
    })
})

test("in testnet mode the stack's host is loopback unless STACK_HOST names another", async () => {
    await withDeployment({ TESTBED_MODE: "testnet" }, async () => {
        const unset = await resolveTestnetStack(() => {})
        process.env.STACK_HOST = "192.168.1.20"
        const named = await resolveTestnetStack(() => {})

        assert.match(unset.publicRpcUrl, /^http:\/\/127\.0\.0\.1:/)
        assert.match(named.publicRpcUrl, /^http:\/\/192\.168\.1\.20:/)
    })
})

test("resolveTestnetStack turns a missing Safe into a line naming the address and chain", async () => {
    const noSafe = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
            const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string }
            response.writeHead(200, { "content-type": "application/json" })
            response.end(
                call.method === "eth_chainId"
                    ? JSON.stringify({ jsonrpc: "2.0", id: call.id, result: toHex(DEPLOYED_CHAIN_ID) })
                    : call.method === "eth_getBalance"
                      ? JSON.stringify({ jsonrpc: "2.0", id: call.id, result: "0x0" })
                      : JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32000, message: "no code" } })
            )
        })
    })
    await new Promise<void>((resolve) => noSafe.listen(0, "127.0.0.1", () => resolve()))
    try {
        await withDeployment({}, async () => {
            process.env.RPC_URL = `http://127.0.0.1:${(noSafe.address() as AddressInfo).port}`

            await assert.rejects(
                resolveTestnetStack(() => {}),
                (error: unknown) =>
                    error instanceof OperatorError &&
                    error.message.includes(ADDRESSES.governanceSafe) &&
                    error.message.includes(`chain ${DEPLOYED_CHAIN_ID}`)
            )
        })
    } finally {
        noSafe.closeAllConnections()
        await new Promise<void>((resolve) => noSafe.close(() => resolve()))
    }
})

async function resolveWithSafeRead(reply: (method: string) => { status: number; body: object }): Promise<unknown> {
    const upstream = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
            const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id: number; method: string }
            const { status, body } = reply(call.method)
            response.writeHead(status, { "content-type": "application/json" })
            response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...body }))
        })
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
    try {
        return await withDeployment({}, async () => {
            process.env.RPC_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
            return resolveTestnetStack(() => {}).then(
                () => undefined,
                (error: unknown) => error
            )
        })
    } finally {
        upstream.closeAllConnections()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
}

test("resolveTestnetStack suggests another chain only when the Safe's address holds no contract", async () => {
    const error = await resolveWithSafeRead((method) => ({
        status: 200,
        body: {
            result: method === "eth_chainId" ? toHex(DEPLOYED_CHAIN_ID) : method === "eth_getBalance" ? "0x0" : "0x"
        }
    }))

    assert.ok(error instanceof OperatorError)
    assert.match(error.message, /no Safe answers at 0x.*another chain/)
})

test("resolveTestnetStack keeps the cause of a refused Safe read and does not blame the chain", async () => {
    const error = await resolveWithSafeRead((method) =>
        method === "eth_chainId" || method === "eth_getBalance"
            ? { status: 200, body: { result: method === "eth_chainId" ? toHex(DEPLOYED_CHAIN_ID) : "0x0" } }
            : { status: 200, body: { error: { code: -32000, message: "upstream unavailable" } } }
    )

    assert.ok(error instanceof OperatorError)
    assert.match(error.message, /could not read the Safe at 0x.*upstream unavailable/)
    assert.ok(!/another chain/.test(error.message), error.message)
})

test("resolveTestnetStack names the default deployment file path when there is none", async () => {
    await withTestnetEnvironment({}, async () => {
        await assert.rejects(
            resolveTestnetStack(() => {}),
            (error: unknown) =>
                error instanceof OperatorError &&
                error.message.includes(`no deployment file at ${deploymentFilePath(DEPLOYED_CHAIN_ID)}`)
        )
    })
})

test("resolveTestnetStack names the DEPLOYMENT_FILE it was pointed at when that is missing", async () => {
    await withTestnetEnvironment({ DEPLOYMENT_FILE: "/nonexistent/deployment.json" }, async () => {
        await assert.rejects(
            resolveTestnetStack(() => {}),
            (error: unknown) =>
                error instanceof OperatorError &&
                error.message.includes("no deployment file at /nonexistent/deployment.json")
        )
    })
})

test("resolveTestnetStack resolves a relative DEPLOYMENT_FILE from the repository root, not the working directory", async () => {
    await withTestnetEnvironment({ DEPLOYMENT_FILE: "missing/deployment.json" }, async () => {
        await assert.rejects(
            resolveTestnetStack(() => {}),
            (error: unknown) =>
                error instanceof OperatorError &&
                error.message.includes(`no deployment file at ${join(REPOSITORY_ROOT, "missing/deployment.json")}`)
        )
    })
})

test("deploymentFileFor keeps an absolute path, anchors a relative one at the repository root and defaults by chain", () => {
    assert.equal(deploymentFileFor("/tmp/deployment.json", 1), "/tmp/deployment.json")
    assert.equal(
        deploymentFileFor("packages/contracts/deployments/x.json", 1),
        join(REPOSITORY_ROOT, "packages/contracts/deployments/x.json")
    )
    assert.equal(deploymentFileFor(undefined, 1), deploymentFilePath(1))
    assert.equal(deploymentFileFor("", 1), deploymentFilePath(1))
})

test("resolveTestnetStack reads the deployment file named by DEPLOYMENT_FILE and the Safe's version from the chain", async () => {
    await withDeployment({}, async () => {
        const stack = await resolveTestnetStack(() => {})

        assert.equal(stack.chainId, DEPLOYED_CHAIN_ID)
        assert.equal(stack.deployBlock, 123n)
        assert.equal(stack.groupId, 5n)
        assert.equal(stack.safeVersion, "1.4.1")
        assert.deepEqual(stack.addresses, {
            ...ADDRESSES,
            announcer: ERC5564_ANNOUNCER_ADDRESS,
            semaphore: SEMAPHORE_ADDRESS,
            entryPoint: entryPoint08Address,
            accountImplementation: SIMPLE_7702_ACCOUNT_ADDRESS
        })
    })
})

test("resolveTestnetStack signs as OWNER and mirrors the paymaster group from the deployment's block at a block's pace", async () => {
    await withDeployment({}, async () => {
        const stack = await resolveTestnetStack(() => {})

        assert.equal(stack.chain.deployer, OWNER.address)
        assert.deepEqual(stack.paymasterMirror, {
            paymaster: { abi: PAYMASTER_GROUP_ABI, address: ADDRESSES.paymaster },
            group: { abi: [], address: ADDRESSES.networkMemberGroup },
            paymasterGroupFromBlock: 123n,
            pollingIntervalMs: 12_000
        })
        assert.equal(stack.logConfirmations, 2)
    })
})

test("resolveTestnetStack defaults the log window and the public RPC URL, and takes the bundler's key from the environment", async () => {
    await withDeployment({}, async () => {
        const stack = await resolveTestnetStack(() => {})

        assert.equal(stack.logWindowBlocks, 10_000)
        assert.equal(stack.bundlerAccount.address, BUNDLER.address)
        assert.equal(stack.publicRpcUrl, `http://${lanAddress()}:${STACK_PORT}`)
    })
})

test("resolveTestnetStack takes the log window and public RPC URL from the environment", async () => {
    await withDeployment(
        { STACK_LOG_WINDOW_BLOCKS: "777", STACK_PUBLIC_RPC_URL: "https://rpc.example.test" },
        async () => {
            const stack = await resolveTestnetStack(() => {})

            assert.equal(stack.logWindowBlocks, 777)
            assert.equal(stack.publicRpcUrl, "https://rpc.example.test")
        }
    )
})

test("STACK_BUNDLER_PRIVATE_KEY is read with or without 0x, and a malformed one is refused without echoing it", async () => {
    for (const spelling of [BUNDLER_KEY, BUNDLER_KEY.slice(2), `  ${BUNDLER_KEY}  `]) {
        await withDeployment({ STACK_BUNDLER_PRIVATE_KEY: spelling }, async () => {
            assert.equal((await resolveTestnetStack(() => {})).bundlerAccount.address, BUNDLER.address)
        })
    }
    for (const bad of [BUNDLER_KEY.slice(0, -2), `${BUNDLER_KEY}00`, `0x${"zz".repeat(32)}`, "hunter2-secret"]) {
        await withDeployment({ STACK_BUNDLER_PRIVATE_KEY: bad }, async () => {
            await assert.rejects(
                resolveTestnetStack(() => {}),
                (error: unknown) =>
                    error instanceof OperatorError &&
                    error.message.includes("STACK_BUNDLER_PRIVATE_KEY") &&
                    !error.message.includes(bad)
            )
        })
    }
})

test("STACK_PUBLIC_RPC_URL is refused when it carries RPC_URL's key, which would put the provider key in stack.json", async () => {
    await withDeployment({}, async () => {
        const base = process.env.RPC_URL
        const keyed = `${base}/v2/SECRETKEY?apikey=SECRETKEY`
        process.env.RPC_URL = keyed

        for (const same of [
            keyed,
            `${base}/v2/SECRETKEY/?apikey=SECRETKEY`,
            keyed.replace(/^https:/, "http:"),
            `${keyed}-other`,
            keyed.toUpperCase().replace(/^HTTPS/, "https")
        ]) {
            process.env.STACK_PUBLIC_RPC_URL = same
            await assert.rejects(
                resolveTestnetStack(() => {}),
                (error: unknown) =>
                    error instanceof OperatorError &&
                    /STACK_PUBLIC_RPC_URL repeats RPC_URL/.test(error.message) &&
                    !error.message.includes("SECRETKEY")
            )
        }

        process.env.STACK_PUBLIC_RPC_URL = "https://public-rpc.example.org/"
        assert.equal((await resolveTestnetStack(() => {})).publicRpcUrl, "https://public-rpc.example.org/")
    })
})

test("an empty STACK_PUBLIC_RPC_URL is no override, and stack.json gets the proxy's address", async () => {
    await withDeployment({ STACK_PUBLIC_RPC_URL: "" }, async () => {
        const stack = await resolveTestnetStack(() => {})

        assert.match(stack.publicRpcUrl, /^http:\/\/.+:\d+$/)
        assert.equal(publicRpcOverride(), undefined)
    })
})

test("resolveTestnetStack takes the chain id from the file, so a provider on another chain fails the preflight", async () => {
    const deployment = writeDeployment({ chainId: 11155111 })
    try {
        await withTestnetEnvironment({ DEPLOYMENT_FILE: deployment.file }, async () => {
            const stack = await resolveTestnetStack(() => {})

            assert.equal(stack.chainId, 11155111)
            someLine(
                await preflightLines(stack, fakeClient({ ...healthyWorld(stack), rpcChainId: DEPLOYED_CHAIN_ID })),
                /chain id/
            )
        })
    } finally {
        deployment.remove()
    }
})

test("STACK_LOG_WINDOW_BLOCKS must be a positive integer; an empty one is the default", async () => {
    for (const bad of ["0", "-5", "abc", "1.5"]) {
        await withDeployment({ STACK_LOG_WINDOW_BLOCKS: bad }, async () => {
            await assert.rejects(
                resolveTestnetStack(() => {}),
                (error: unknown) => error instanceof OperatorError && error.message.includes(`"${bad}"`)
            )
        })
    }
    await withDeployment({ STACK_LOG_WINDOW_BLOCKS: "" }, async () => {
        assert.equal((await resolveTestnetStack(() => {})).logWindowBlocks, 10_000)
    })
    await withDeployment({ STACK_LOG_WINDOW_BLOCKS: "500" }, async () => {
        assert.equal((await resolveTestnetStack(() => {})).logWindowBlocks, 500)
    })
})

test("the serve scope does not check the governance signer of a founder the registry has not approved", async () => {
    const { lines } = await failuresOf(deployedWorld)

    assert.ok(!lines.some((line) => /registry's governance signer/.test(line)), lines.join("\n"))
})

test("the genesis scope finds OWNER's seat when an earlier signer log belongs to a member that is not approved", async () => {
    const { lines } = await failuresOf(
        (stack) => ({
            ...healthyWorld(stack),
            published: [
                { memberNetworkId: `0x${"aa".repeat(32)}`, governanceSigner: OWNER.address },
                { memberNetworkId: FOUNDING_MEMBER_ID, governanceSigner: OWNER.address }
            ]
        }),
        "genesis",
        heldKeysOf
    )

    assert.deepEqual(lines, [])
})

test("the genesis scope names an OWNER whose only signer log is for a member that is not approved", async () => {
    const { lines } = await failuresOf(
        (stack) => ({
            ...pendingWorld(stack),
            published: [{ memberNetworkId: `0x${"aa".repeat(32)}`, governanceSigner: OWNER.address }]
        }),
        "genesis",
        heldKeysOf
    )

    oneFailure(lines, /no approved member's governance signer/)
})

async function withPublicRpcSettings(
    settings: { RPC_URL?: string; STACK_PUBLIC_RPC_URL?: string },
    run: () => void
): Promise<void> {
    const saved = [process.env.RPC_URL, process.env.STACK_PUBLIC_RPC_URL]
    delete process.env.RPC_URL
    delete process.env.STACK_PUBLIC_RPC_URL
    Object.assign(process.env, settings)
    try {
        run()
    } finally {
        for (const [name, value] of [
            ["RPC_URL", saved[0]],
            ["STACK_PUBLIC_RPC_URL", saved[1]]
        ] as const) {
            if (value === undefined) delete process.env[name]
            else process.env[name] = value
        }
    }
}

test("publicRpcOverride refuses an override that repeats only RPC_URL's path, or only its query", async () => {
    await withPublicRpcSettings(
        {
            RPC_URL: "https://eth.example.io/v2/SECRETKEY",
            STACK_PUBLIC_RPC_URL: "https://relay.example.org/V2/secretkey"
        },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
    await withPublicRpcSettings(
        {
            RPC_URL: "https://eth.example.io/?apikey=SECRETKEY",
            STACK_PUBLIC_RPC_URL: "https://relay.example.org/?APIKEY=secretkey"
        },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
})

test("publicRpcOverride refuses RPC_URL's userinfo, its host and a host-label key", async () => {
    await withPublicRpcSettings(
        {
            RPC_URL: "https://user:SECRETKEY@eth.example.io/",
            STACK_PUBLIC_RPC_URL: "https://relay.example.org/secretkey"
        },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
    await withPublicRpcSettings(
        { RPC_URL: "https://eth.example.io/", STACK_PUBLIC_RPC_URL: "https://ETH.example.io/" },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
    await withPublicRpcSettings(
        { RPC_URL: "https://SECRETKEY.provider.example/", STACK_PUBLIC_RPC_URL: "https://secretkey.provider.example/" },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
    await withPublicRpcSettings(
        { RPC_URL: "https://eth.example.io/", STACK_PUBLIC_RPC_URL: "https://eth.example.io/other" },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
})

test("publicRpcOverride compares hostnames, so a port does not hide the provider's host", async () => {
    await withPublicRpcSettings(
        { RPC_URL: "https://eth.example.io:8545/", STACK_PUBLIC_RPC_URL: "https://eth.example.io:9000/" },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
    await withPublicRpcSettings(
        { RPC_URL: "https://eth.example.io/", STACK_PUBLIC_RPC_URL: "https://eth.example.io:8443/" },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
})

test("publicRpcOverride refuses an override whose hostname contains the provider's, as a host-label key does", async () => {
    await withPublicRpcSettings(
        {
            RPC_URL: "https://secretkey.provider.example/",
            STACK_PUBLIC_RPC_URL: "https://secretkey.provider.example.relay.org/"
        },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
})

test("publicRpcOverride matches userinfo on the password, not on a bare username", async () => {
    await withPublicRpcSettings(
        { RPC_URL: "https://eth:hunter2@provider.example/", STACK_PUBLIC_RPC_URL: "https://relay.org/x?token=hunter2" },
        () => assert.throws(() => publicRpcOverride(), /repeats RPC_URL/)
    )
    await withPublicRpcSettings(
        { RPC_URL: "https://eth:hunter2@provider.example/", STACK_PUBLIC_RPC_URL: "https://eth.relay.org/" },
        () => assert.equal(publicRpcOverride(), "https://eth.relay.org/")
    )
})

test("publicRpcOverride does not crash on a raw percent sign in RPC_URL's userinfo", async () => {
    await withPublicRpcSettings(
        { RPC_URL: "https://eth:100%@provider.example/", STACK_PUBLIC_RPC_URL: "https://relay.org/" },
        () => assert.equal(publicRpcOverride(), "https://relay.org/")
    )
})

test("publicRpcOverride takes an override on another host when RPC_URL has no path or query to leak, or is unset", async () => {
    await withPublicRpcSettings(
        { RPC_URL: "https://eth.example.io/", STACK_PUBLIC_RPC_URL: "https://public-rpc.example.org/" },
        () => assert.equal(publicRpcOverride(), "https://public-rpc.example.org/")
    )
    await withPublicRpcSettings({ STACK_PUBLIC_RPC_URL: "https://relay.example.org/v2/x" }, () =>
        assert.equal(publicRpcOverride(), "https://relay.example.org/v2/x")
    )
    await withPublicRpcSettings({ RPC_URL: "https://eth.example.io/v2/SECRETKEY" }, () =>
        assert.equal(publicRpcOverride(), undefined)
    )
})

test("publicRpcOverride does not fail on an RPC_URL it cannot parse", async () => {
    await withPublicRpcSettings({ RPC_URL: "not a url", STACK_PUBLIC_RPC_URL: "https://relay.example.org" }, () =>
        assert.equal(publicRpcOverride(), "https://relay.example.org")
    )
})

test("the genesis scope does not find an OWNER signer log from before the deployment", async () => {
    const { lines } = await failuresOf(
        (stack) => ({ ...pendingWorld(stack), publishedBlock: DEPLOY_BLOCK - 1n }),
        "genesis",
        heldKeysOf
    )

    oneFailure(lines, /^OWNER 0x[0-9a-fA-F]{40} is no approved member.s governance signer/)
})
