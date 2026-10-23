import assert from "node:assert/strict"
import { test } from "node:test"
import { randomBytes } from "@noble/hashes/utils"
import {
    decodeFunctionData,
    defineChain,
    encodePacked,
    getAddress,
    isAddressEqual,
    keccak256,
    parseAbi,
    parseEther,
    type Address,
    type Hex,
    type PublicClient,
    type WalletClient
} from "viem"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { issuerLeaf } from "@coordination-network/credential"
import {
    governanceThreshold,
    hashSafeTransaction,
    NETWORK_MEMBER_GOVERNANCE_ABI,
    OperationType,
    type SafeContext
} from "@coordination-network/network-member-governance"
import type { Chain } from "./anvil"
import { runGenesis } from "./genesis"
import { buildMembers, type Member } from "./members"
import { OperatorError } from "./operator-error"
import { PAYMASTER_GROUP_ABI } from "./paymaster-group"
import type { StackAddresses } from "./serve"
import { accountKeyOf, type TestnetStack } from "./testnet-stack"

const CHAIN_ID = 11155111
const GROUP_ID = 7n
const PAYMASTER_GROUP_ID = 9n
const DEPLOY_BLOCK = 100n
const HEAD = 200n

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

const EXEC_ABI = parseAbi([
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool success)",
    "function approveHash(bytes32 hashToApprove)",
    "function depositTo(address account) payable",
    "function publishIssuerKey(bytes32 memberNetworkId, uint256 publicKeyX, uint256 publicKeyY) returns (uint256)"
])

const OWNER = privateKeyToAccount(generatePrivateKey())
const BUNDLER = privateKeyToAccount(generatePrivateKey())
/** The founding member the runbook's deploy admits, seated at OWNER. */
const FOUNDING_MEMBER_ID: Hex = `0x${"0f".repeat(32)}`
const FOUNDING_COMMITMENT = 12345n
const OTHER_ADDRESS = getAddress(`0x${"44".repeat(20)}`)

interface Sent {
    from: Address
    to: Address
    kind: string
}

interface MemberLog {
    commitment: bigint
    blockNumber: bigint
}

/** The chain as genesis sees it: a Safe that enforces its threshold, and the governance contract's
 *  own `_checkSafeState`, changed only by the transactions genesis sends. */
class FakeNetwork {
    balances = new Map<Address, bigint>()
    owners: Address[] = [OWNER.address]
    threshold = 1n
    nonce = 0n
    approvedHashes = new Set<string>()
    approved = new Set<string>([FOUNDING_MEMBER_ID])
    /** What each admission put on chain, by networkId. */
    admitted = new Map<string, { accountKeyX: bigint; accountKeyY: bigint; commitment: bigint; signer: Address }>()
    issuerKeys = new Map<string, [bigint, bigint][]>()
    memberLogs: MemberLog[] = [{ commitment: FOUNDING_COMMITMENT, blockNumber: DEPLOY_BLOCK + 1n }]
    paymasterMembers = new Set<bigint>()
    deposit = 0n
    onChainHashOverride?: Hex
    head = HEAD
    nonceReads = 0
    /** After an addMember, the next hasMember read for that commitment still answers false. */
    lagMirror = false
    private hiddenOnce = new Set<bigint>()
    /** After an execution, this many reads of the Safe's nonce answer with the state before it. */
    staleNonceReads = 0
    private before?: { owners: Address[]; threshold: bigint; nonce: bigint }
    /** Owners that approved the transaction at a given Safe nonce in an earlier run. */
    preapproved = new Map<string, Address[]>()
    /** Receipts for transactions of this kind come back reverted. */
    revertKind?: string
    depositedFor: Address[] = []
    accountsUsed: { kind: string; account: unknown }[] = []
    mirrored: { args: readonly [bigint, bigint]; account: unknown }[] = []
    admissions: { nonce: bigint; expectedMemberCount: bigint }[] = []
    sent: Sent[] = []
    private kindByHash = new Map<string, string>()
    private counter = 0

    constructor(readonly context: SafeContext) {}

    kinds(kind: string): Sent[] {
        return this.sent.filter((entry) => entry.kind === kind)
    }

    private safeHash(args: readonly unknown[]): Hex {
        const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, nonce] = args as [
            Address,
            bigint,
            Hex,
            number,
            bigint,
            bigint,
            bigint,
            Address,
            Address,
            bigint
        ]
        return hashSafeTransaction(this.context, {
            to,
            value: value.toString(),
            data,
            operation: operation as OperationType,
            safeTxGas: safeTxGas.toString(),
            baseGas: baseGas.toString(),
            gasPrice: gasPrice.toString(),
            gasToken,
            refundReceiver,
            nonce: Number(nonce)
        })
    }

    private nextHash(kind: string): Hex {
        this.counter += 1
        const hash = `0x${this.counter.toString(16).padStart(64, "0")}` as Hex
        this.kindByHash.set(hash, kind)
        return hash
    }

    publicClient(): PublicClient {
        const client = {
            getBlockNumber: async () => this.head,
            getBalance: async ({ address }: { address: Address }) => this.balances.get(address) ?? 0n,
            waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => ({
                status:
                    this.revertKind !== undefined && this.kindByHash.get(hash) === this.revertKind
                        ? "reverted"
                        : "success"
            }),
            getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
                this.memberLogs
                    .filter((log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock)
                    .map((log) => ({ args: { identityCommitment: log.commitment } })),
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
                        return this.before?.owners ?? this.owners
                    case "getThreshold":
                        return this.before?.threshold ?? this.threshold
                    case "nonce": {
                        this.nonceReads += 1
                        const answer = this.before?.nonce ?? this.nonce
                        if (this.before && (this.staleNonceReads -= 1) <= 0) this.before = undefined
                        return answer
                    }
                    case "approvedHashes":
                        return this.approvedHashes.has(`${String(args?.[0]).toLowerCase()}:${args?.[1]}`) ? 1n : 0n
                    case "getTransactionHash": {
                        const hash = this.safeHash(args ?? [])
                        for (const owner of this.preapproved.get(String(args?.[9])) ?? []) {
                            this.approvedHashes.add(`${owner.toLowerCase()}:${hash}`)
                        }
                        return this.onChainHashOverride ?? hash
                    }
                    case "isApproved":
                        return this.approved.has(String(args?.[0]))
                    case "issuerKeysOf":
                        return (this.issuerKeys.get(String(args?.[0])) ?? []).map((key) => issuerLeaf(key))
                    case "getDeposit":
                        return this.deposit
                    case "GROUP_ID":
                        return PAYMASTER_GROUP_ID
                    case "hasMember":
                        if (this.hiddenOnce.delete(args?.[1] as bigint)) return false
                        return this.paymasterMembers.has(args?.[1] as bigint)
                    case "hasNetworkMember":
                        return this.memberLogs.some((log) => log.commitment === args?.[0])
                    default:
                        throw new Error(`unexpected read ${functionName} at ${address}`)
                }
            }
        }
        return client as unknown as PublicClient
    }

    walletClient(): WalletClient {
        const client = {
            sendTransaction: async ({
                account,
                to,
                data,
                value
            }: {
                account: { address: Address }
                to: Address
                data?: Hex
                value?: bigint
            }) => {
                const from = account.address
                if (!data) {
                    const hash = this.nextHash("transfer")
                    this.accountsUsed.push({ kind: "transfer", account })
                    this.balances.set(to, (this.balances.get(to) ?? 0n) + (value ?? 0n))
                    this.sent.push({ from, to, kind: "transfer" })
                    return hash
                }
                const call = decodeFunctionData({ abi: EXEC_ABI, data })
                const hash = this.nextHash(call.functionName)
                this.sent.push({ from, to, kind: call.functionName })
                switch (call.functionName) {
                    case "approveHash": {
                        const key = `${from.toLowerCase()}:${call.args[0]}`
                        assert.ok(!this.approvedHashes.has(key), `${from} approved ${call.args[0]} twice`)
                        const approvals = [...this.approvedHashes].filter((entry) => entry.endsWith(`:${call.args[0]}`))
                        assert.ok(
                            BigInt(approvals.length) < this.threshold,
                            `an approval was sent after the quorum of ${this.threshold} was met`
                        )
                        this.approvedHashes.add(key)
                        break
                    }
                    case "execTransaction":
                        this.execute(from, call.args as unknown as ExecArgs)
                        break
                    case "depositTo":
                        this.depositedFor.push(call.args[0])
                        this.deposit += value ?? 0n
                        break
                    case "publishIssuerKey":
                        assert.ok(this.approved.has(call.args[0]), "an issuer key is published only once approved")
                        assert.equal(getAddress(`0x${call.args[0].slice(-40)}`), getAddress(from))
                        this.issuerKeys.set(call.args[0], [
                            ...(this.issuerKeys.get(call.args[0]) ?? []),
                            [call.args[1], call.args[2]]
                        ])
                        break
                    default:
                        throw new Error("unexpected call")
                }
                return hash
            },
            writeContract: async ({ args, account }: { args: readonly [bigint, bigint]; account: unknown }) => {
                const hash = this.nextHash("addMember")
                this.sent.push({ from: OWNER.address, to: ADDRESSES.paymaster, kind: "addMember" })
                this.mirrored.push({ args, account })
                this.paymasterMembers.add(args[1])
                if (this.lagMirror) this.hiddenOnce.add(args[1])
                return hash
            }
        }
        return client as unknown as WalletClient
    }

    private execute(from: Address, args: ExecArgs): void {
        const [to, , data, operation, safeTxGas, baseGas, gasPrice, gasToken, refundReceiver, signatures] = args
        const safeTxHash = this.safeHash([
            to,
            0n,
            data,
            operation,
            safeTxGas,
            baseGas,
            gasPrice,
            gasToken,
            refundReceiver,
            this.nonce
        ])
        const signerCount = (signatures.length - 2) / 2 / 65
        assert.ok(
            BigInt(signerCount) >= this.threshold,
            `GS020: ${signerCount} signatures for threshold ${this.threshold}`
        )
        for (let index = 0; index < signerCount; index += 1) {
            const entry = signatures.slice(2 + index * 130, 2 + (index + 1) * 130)
            const signer = getAddress(`0x${entry.slice(24, 64)}`)
            assert.ok(
                this.owners.some((owner) => isAddressEqual(owner, signer)),
                `GS026: ${signer} is not an owner`
            )
            assert.ok(
                isAddressEqual(signer, from) || this.approvedHashes.has(`${signer.toLowerCase()}:${safeTxHash}`),
                `GS025: ${signer} has not approved`
            )
        }
        const nonce = this.nonce
        if (this.staleNonceReads > 0) {
            this.before = { owners: this.owners, threshold: this.threshold, nonce: this.nonce }
        }
        this.nonce += 1n

        assert.ok(isAddressEqual(to, ADDRESSES.networkMemberGovernance), "the Safe executes only admissions here")
        const { functionName, args: admission } = decodeFunctionData({ abi: NETWORK_MEMBER_GOVERNANCE_ABI, data })
        assert.equal(functionName, "admitMember")
        const [accountKeyX, accountKeyY, commitment, signer, expectedMemberCount] = admission as [
            bigint,
            bigint,
            bigint,
            Address,
            bigint
        ]
        // The governance contract's `_checkSafeState`.
        assert.equal(expectedMemberCount, BigInt(this.owners.length), "MemberCountChanged")
        assert.equal(this.threshold, BigInt(governanceThreshold(this.owners.length)), "ThresholdMismatch")
        assert.ok(!this.owners.some((owner) => isAddressEqual(owner, signer)), "GS204: already an owner")

        const networkId = keccak256(encodePacked(["uint256", "uint256"], [accountKeyX, accountKeyY]))
        this.admitted.set(networkId, { accountKeyX, accountKeyY, commitment, signer })
        this.admissions.push({ nonce, expectedMemberCount })
        this.approved.add(networkId)
        this.memberLogs.push({ commitment, blockNumber: DEPLOY_BLOCK + 2n + nonce })
        this.owners = [signer, ...this.owners]
        this.threshold = BigInt(governanceThreshold(this.owners.length))
    }
}

type ExecArgs = readonly [Address, bigint, Hex, number, bigint, bigint, bigint, Address, Address, Hex]

interface Setup {
    network: FakeNetwork
    stack: TestnetStack
    heldKeys: Hex[]
    founders: Member[]
    messages: string[]
}

/** A network as `deployAndConfigureAll` leaves it: Safe [OWNER] at threshold 1, the founding member in. */
function setup(options: { funded?: boolean; members?: Member[] } = {}): Setup {
    const members = options.members ?? buildMembers([randomBytes(32), randomBytes(32), randomBytes(32)], 11155111)
    const founders = members.filter((member) => member.role === "founder")
    const network = new FakeNetwork({
        safeAddress: ADDRESSES.governanceSafe,
        chainId: CHAIN_ID,
        safeVersion: "1.4.1"
    })
    network.balances.set(OWNER.address, parseEther("10"))
    if (options.funded) {
        for (const member of members) network.balances.set(member.authAddress, parseEther("0.05"))
        for (const founder of founders) network.balances.set(founder.governanceSignerAddress, parseEther("0.05"))
        network.balances.set(BUNDLER.address, parseEther("0.2"))
        network.deposit = parseEther("0.05")
    }
    const chain: Chain = {
        chainDefinition: defineChain({
            id: CHAIN_ID,
            name: "sepolia",
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: ["http://rpc.test"] } }
        }),
        deployer: OWNER.address,
        signer: OWNER,
        publicClient: network.publicClient(),
        rpcUrl: "http://rpc.test",
        blockScanWindowSize: 10n,
        stop: () => {},
        walletClient: network.walletClient()
    }
    const stack: TestnetStack = {
        chain,
        addresses: ADDRESSES,
        deployBlock: DEPLOY_BLOCK,
        groupId: GROUP_ID,
        safeVersion: "1.4.1",
        chainId: CHAIN_ID,
        members,
        logWindowBlocks: 10_000,
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
    const heldKeys = founders.flatMap((founder) => [founder.governanceSignerPrivateKey, founder.authPrivateKey])
    return { network, stack, heldKeys, founders, messages: [] }
}

async function genesis(world: Setup): Promise<string[]> {
    return runGenesis(world.stack, world.heldKeys, (message) => world.messages.push(message))
}

/** Everything is already true: only the parts a test is about are left undone. */
async function settled(world: Setup): Promise<void> {
    const { network, founders } = world
    for (const founder of founders) {
        const { accountKeyX, accountKeyY } = accountKeyOf(founder)
        network.approved.add(founder.networkId)
        network.admitted.set(founder.networkId, {
            accountKeyX,
            accountKeyY,
            commitment: founder.semaphoreCommitment,
            signer: founder.governanceSignerAddress
        })
        network.issuerKeys.set(founder.networkId, [await founder.signer.getPublicKey()])
        network.paymasterMembers.add(founder.semaphoreCommitment)
        network.memberLogs.push({ commitment: founder.semaphoreCommitment, blockNumber: DEPLOY_BLOCK + 5n })
    }
    network.paymasterMembers.add(FOUNDING_COMMITMENT)
    network.owners = [...founders.map((founder) => founder.governanceSignerAddress), OWNER.address]
    network.threshold = BigInt(governanceThreshold(network.owners.length))
}

test("genesis walks the Safe [OWNER] thr 1, then 2 owners thr 2, then 3 owners thr 2, signing each admission", async () => {
    const world = setup({ funded: true })

    await genesis(world)

    const { network, founders } = world
    for (const founder of founders) assert.ok(network.approved.has(founder.networkId), founder.name)
    assert.equal(network.owners.length, 3)
    assert.deepEqual(
        new Set(network.owners.map((owner) => owner.toLowerCase())),
        new Set(
            [OWNER.address, ...founders.map((founder) => founder.governanceSignerAddress)].map((a) => a.toLowerCase())
        )
    )
    assert.equal(network.threshold, 2n)
    assert.deepEqual(network.admissions, [
        { nonce: 0n, expectedMemberCount: 1n },
        { nonce: 1n, expectedMemberCount: 2n }
    ])
    // OWNER alone signs Member A's; OWNER and Member A sign Member B's, and OWNER sends both.
    const walk = network.sent.slice(0, 5)
    assert.deepEqual(
        [walk[0], walk[1]].map((entry) => [entry.kind, entry.from]),
        [
            ["approveHash", OWNER.address],
            ["execTransaction", OWNER.address]
        ]
    )
    assert.deepEqual(
        [walk[2], walk[3]].map((entry) => entry.from.toLowerCase()).sort(),
        [OWNER.address, founders[0].governanceSignerAddress].map((address) => address.toLowerCase()).sort()
    )
    assert.deepEqual(
        [walk[2], walk[3], walk[4]].map((entry) => entry.kind),
        ["approveHash", "approveHash", "execTransaction"]
    )
    assert.equal(walk[4].from, OWNER.address)
})

test("genesis admits each founder's own commitment and account key", async () => {
    const world = setup({ funded: true })

    await genesis(world)

    for (const founder of world.founders) {
        const admitted = world.network.admitted.get(founder.networkId)
        const { accountKeyX, accountKeyY } = accountKeyOf(founder)
        assert.deepEqual(admitted, {
            accountKeyX,
            accountKeyY,
            commitment: founder.semaphoreCommitment,
            signer: founder.governanceSignerAddress
        })
    }
})

test("a second genesis run sends nothing", async () => {
    const world = setup({ funded: true })
    await genesis(world)
    const sentBefore = world.network.sent.length

    assert.deepEqual(await genesis(world), [])
    assert.equal(world.network.sent.length, sentBefore)
})

test("genesis does nothing to a network that is already set up", async () => {
    const world = setup({ funded: true })
    await settled(world)

    assert.deepEqual(await genesis(world), [])
    assert.deepEqual(world.network.sent, [])
})

test("genesis resumes an admission whose approvals were partly sent, sending only the missing ones", async () => {
    const world = setup({ funded: true })
    await settled(world)
    const [memberA, memberB] = world.founders
    // Member B is not in yet: Safe [Member A, OWNER] at threshold 2, and OWNER already approved the admission.
    world.network.approved.delete(memberB.networkId)
    world.network.admitted.delete(memberB.networkId)
    world.network.issuerKeys.delete(memberB.networkId)
    world.network.paymasterMembers.delete(memberB.semaphoreCommitment)
    world.network.memberLogs = world.network.memberLogs.filter((log) => log.commitment !== memberB.semaphoreCommitment)
    world.network.owners = [memberA.governanceSignerAddress, OWNER.address]
    world.network.threshold = 2n
    world.network.nonce = 1n
    world.network.preapproved.set("1", [OWNER.address])

    await genesis(world)

    const approvals = world.network.kinds("approveHash")
    assert.deepEqual(
        approvals.map((entry) => entry.from),
        [memberA.governanceSignerAddress]
    )
    assert.ok(world.network.approved.has(memberB.networkId))
})

test("genesis skips a founder the registry has already approved", async () => {
    const world = setup({ funded: true })
    await settled(world)
    const [, memberB] = world.founders
    world.network.approved.delete(memberB.networkId)
    world.network.admitted.delete(memberB.networkId)
    world.network.issuerKeys.delete(memberB.networkId)
    world.network.paymasterMembers.delete(memberB.semaphoreCommitment)
    world.network.memberLogs = world.network.memberLogs.filter((log) => log.commitment !== memberB.semaphoreCommitment)
    world.network.owners = [world.founders[0].governanceSignerAddress, OWNER.address]
    world.network.threshold = 2n

    await genesis(world)

    assert.equal(world.network.kinds("execTransaction").length, 1)
    assert.deepEqual([...world.network.admitted.keys()], [world.founders[0].networkId, memberB.networkId])
})

test("genesis refuses, sending nothing, when the held keys cannot reach a later admission's threshold", async () => {
    const world = setup({ funded: true })
    // Without Member A's governance key nobody can co-sign Member B's admission at two owners.
    world.heldKeys = [world.founders[1].governanceSignerPrivateKey, ...world.heldKeys.slice(2)]
    world.heldKeys = world.heldKeys.filter((key) => key !== world.founders[0].governanceSignerPrivateKey)

    await assert.rejects(
        genesis(world),
        (error: unknown) =>
            error instanceof OperatorError && /admit Member B: the Safe needs 2 approvals.*reach 1/.test(error.message)
    )
    assert.deepEqual(world.network.sent, [])
    assert.deepEqual(world.messages, [])
})

test("genesis refuses, sending nothing, when the Safe's threshold is not the governance rule's", async () => {
    const world = setup({ funded: true })
    world.network.owners = [OWNER.address, OTHER_ADDRESS]
    world.network.threshold = 1n

    await assert.rejects(
        genesis(world),
        (error: unknown) =>
            error instanceof OperatorError && /threshold is 1 for 2 owner\(s\).*changeThreshold/.test(error.message)
    )
    assert.deepEqual(world.network.sent, [])
})

test("genesis refuses a founder whose governance signer already owns a seat without being approved", async () => {
    const world = setup({ funded: true })
    world.network.owners = [OWNER.address, world.founders[0].governanceSignerAddress]
    world.network.threshold = 2n

    await assert.rejects(
        genesis(world),
        (error: unknown) =>
            error instanceof OperatorError &&
            /Member A's governance signer .* already owns a Safe seat/.test(error.message)
    )
    assert.deepEqual(world.network.sent, [])
})

test("genesis tops up each account below its floor, from OWNER, and leaves the others alone", async () => {
    const world = setup({ funded: true })
    await settled(world)
    const { network, founders } = world
    const [memberA] = founders
    network.balances.set(memberA.authAddress, 0n)
    network.balances.set(memberA.governanceSignerAddress, parseEther("0.009"))
    network.balances.set(BUNDLER.address, parseEther("0.01"))
    network.deposit = parseEther("0.01")

    await genesis(world)

    assert.equal(network.balances.get(memberA.authAddress), parseEther("0.05"))
    assert.equal(network.balances.get(memberA.governanceSignerAddress), parseEther("0.05"))
    assert.equal(network.balances.get(BUNDLER.address), parseEther("0.2"))
    assert.equal(network.deposit, parseEther("0.05"))
    assert.deepEqual(
        network.sent.map((entry) => entry.kind),
        ["transfer", "transfer", "transfer", "depositTo"]
    )
    assert.ok(network.sent.every((entry) => isAddressEqual(entry.from, OWNER.address)))
    assert.equal(network.sent[3].to, ADDRESSES.entryPoint)
    assert.deepEqual(network.depositedFor, [ADDRESSES.paymaster])
})

test("genesis does not fund accounts that sit exactly at their floor, and tops the deposit up by the shortfall only", async () => {
    const world = setup({ funded: true })
    await settled(world)
    const { network, founders, stack } = world
    for (const member of stack.members) network.balances.set(member.authAddress, parseEther("0.01"))
    for (const founder of founders) network.balances.set(founder.governanceSignerAddress, parseEther("0.01"))
    network.balances.set(BUNDLER.address, parseEther("0.05"))
    network.deposit = parseEther("0.04")

    await genesis(world)

    assert.deepEqual(
        network.sent.map((entry) => entry.kind),
        ["depositTo"]
    )
    assert.equal(network.deposit, parseEther("0.05"))
})

test("genesis publishes an issuer key only for a founder without its own, from that org's auth account", async () => {
    const world = setup({ funded: true })
    await settled(world)
    const [memberA, memberB] = world.founders
    world.network.issuerKeys.delete(memberB.networkId)

    await genesis(world)

    const published = world.network.kinds("publishIssuerKey")
    assert.equal(published.length, 1)
    assert.equal(published[0].from, memberB.authAddress)
    assert.deepEqual(world.network.issuerKeys.get(memberB.networkId), [await memberB.signer.getPublicKey()])
    assert.ok(world.network.issuerKeys.has(memberA.networkId))
})

test("genesis publishes a founder's own key when the set lists only another key for it", async () => {
    const world = setup({ funded: true })
    await settled(world)
    const [memberA, memberB] = world.founders
    world.network.issuerKeys.set(memberB.networkId, [await memberA.signer.getPublicKey()])

    await genesis(world)

    assert.equal(world.network.kinds("publishIssuerKey").length, 1)
    assert.deepEqual(world.network.issuerKeys.get(memberB.networkId)?.[1], await memberB.signer.getPublicKey())
})

test("genesis names a founder at the issuer-key cap without its own key, before it sends anything", async () => {
    const world = setup({ funded: true })
    await settled(world)
    const [, memberB] = world.founders
    const [x, y] = await memberB.signer.getPublicKey()
    world.network.issuerKeys.set(
        memberB.networkId,
        Array.from({ length: 8 }, (_, index) => [x + BigInt(index + 1), y] as [bigint, bigint])
    )
    world.network.balances.delete(BUNDLER.address)

    await assert.rejects(
        genesis(world),
        (error: unknown) => error instanceof OperatorError && /Member B already has 8 issuer keys/.test(error.message)
    )
    assert.deepEqual(world.network.sent, [])
    assert.deepEqual(world.messages, [])
})

test("genesis mirrors Member A, Member B and the founding member into the paymaster group, from OWNER", async () => {
    const world = setup({ funded: true })

    const actions = await genesis(world)

    assert.deepEqual(
        new Set(world.network.mirrored.map((entry) => entry.args[1])),
        new Set([FOUNDING_COMMITMENT, ...world.founders.map((founder) => founder.semaphoreCommitment)])
    )
    assert.ok(world.network.mirrored.every((entry) => entry.args[0] === PAYMASTER_GROUP_ID))
    assert.ok(world.network.mirrored.every((entry) => entry.account === OWNER))
    assert.equal(actions.filter((action) => /in the paymaster group/.test(action)).length, 3)
})

test("genesis mirrors the founders it admitted even when the provider's head is behind their admissions", async () => {
    const world = setup({ funded: true })
    world.network.head = DEPLOY_BLOCK + 1n

    await genesis(world)

    for (const founder of world.founders) {
        assert.ok(world.network.paymasterMembers.has(founder.semaphoreCommitment), founder.name)
    }
})

test("genesis sends no second addMember for a founder when the log pass reads a lagging paymaster", async () => {
    const world = setup({ funded: true })
    world.network.lagMirror = true

    await genesis(world)

    const mirroredCommitments = world.network.mirrored.map((entry) => entry.args[1])
    assert.equal(new Set(mirroredCommitments).size, mirroredCommitments.length, mirroredCommitments.join())
})

test("genesis builds each admission from the Safe state its wait observed, with no second read", async () => {
    const world = setup({ funded: true })

    await genesis(world)

    // The pre-spend hash check, the loop's first read, then one read per wait.
    assert.equal(world.network.nonceReads, 4)
})

test("genesis mirrors only the commitments that are missing, and reports the hash of each", async () => {
    const world = setup({ funded: true })
    await settled(world)
    world.network.paymasterMembers.delete(world.founders[0].semaphoreCommitment)

    await genesis(world)

    assert.equal(world.network.kinds("addMember").length, 1)
    assert.ok(
        world.messages.some((message) => /mirror commitment .* into the paymaster group: sent 0x/.test(message)),
        world.messages.join("\n")
    )
})

test("genesis stops when a mirror reverts", async () => {
    const world = setup({ funded: true })
    await settled(world)
    world.network.paymasterMembers.delete(world.founders[0].semaphoreCommitment)
    world.network.revertKind = "addMember"

    await assert.rejects(genesis(world), /mirror commitment .* reverted: 0x/)
})

test("genesis stops at a reverted Safe execution, naming the step and the hash, and runs nothing after", async () => {
    const world = setup({ funded: true })
    world.network.revertKind = "execTransaction"

    await assert.rejects(genesis(world), /^Error: admit Member A reverted: 0x0{63}\d$/)

    const { network } = world
    assert.equal(network.kinds("execTransaction").length, 1)
    assert.deepEqual(network.kinds("publishIssuerKey"), [])
    assert.deepEqual(network.kinds("addMember"), [])
})

test("genesis stops at a reverted funding transfer, before anything else is sent", async () => {
    const world = setup()
    world.network.revertKind = "transfer"

    await assert.rejects(genesis(world), /fund .* reverted: 0x0{63}1$/)

    assert.equal(world.network.sent.length, 1)
})

test("genesis prints a transaction's hash before it waits, so a reverted one still leaves it on screen", async () => {
    const world = setup()
    world.network.revertKind = "transfer"

    await assert.rejects(genesis(world), /reverted/)

    assert.ok(
        world.messages.some((message) => /^fund .*: sent 0x0{63}1$/.test(message)),
        world.messages.join("\n")
    )
})

test("genesis waits for a lagging provider to show each admission before building the next", async () => {
    const world = setup({ funded: true })
    world.network.staleNonceReads = 1

    await genesis(world)

    assert.deepEqual(world.network.admissions, [
        { nonce: 0n, expectedMemberCount: 1n },
        { nonce: 1n, expectedMemberCount: 2n }
    ])
})

test("genesis sends nothing, not even a top-up, when the Safe's transaction hash differs from the SDK's", async () => {
    const world = setup()
    world.network.onChainHashOverride = `0x${"11".repeat(32)}`

    await assert.rejects(genesis(world), /does not match the Safe's own/)

    assert.deepEqual(world.network.sent, [])
})

test("genesis sends OWNER's transactions through the chain's own signer account", async () => {
    const world = setup()

    await genesis(world)

    const fundings = world.network.accountsUsed.filter((entry) => entry.kind === "transfer")
    assert.ok(fundings.length >= 2)
    assert.ok(fundings.every((entry) => entry.account === world.stack.chain.signer))
})

test("genesis never stakes the paymaster: its only paymaster spend is a deposit through the EntryPoint", async () => {
    const world = setup()

    await genesis(world)

    assert.deepEqual(
        world.network.kinds("depositTo").map((entry) => entry.to),
        [ADDRESSES.entryPoint]
    )
})

test("genesis refuses, sending nothing, when OWNER's key is not among the keys it holds", async () => {
    const world = setup({ funded: true })
    world.stack.chain.deployer = OTHER_ADDRESS

    await assert.rejects(
        genesis(world),
        (error: unknown) =>
            error instanceof OperatorError && /OWNER's key is not among the keys genesis holds/.test(error.message)
    )
    assert.deepEqual(world.network.sent, [])
    assert.deepEqual(world.messages, [])
})

test("genesis refuses, sending nothing, when a founder's auth key is not among the keys it holds", async () => {
    const world = setup({ funded: true })
    world.heldKeys = world.founders.map((founder) => founder.governanceSignerPrivateKey)

    await assert.rejects(
        genesis(world),
        (error: unknown) =>
            error instanceof OperatorError &&
            /Member A's auth key is not among the keys genesis holds/.test(error.message)
    )
    assert.deepEqual(world.network.sent, [])
    assert.deepEqual(world.messages, [])
})

test("genesis refuses, sending nothing, when the second founder's governance signer already owns a seat", async () => {
    const world = setup({ funded: true })
    world.network.owners = [OWNER.address, world.founders[1].governanceSignerAddress]
    world.network.threshold = 2n

    await assert.rejects(
        genesis(world),
        (error: unknown) =>
            error instanceof OperatorError &&
            /Member B's governance signer .* already owns a Safe seat/.test(error.message)
    )
    assert.deepEqual(world.network.sent, [])
    assert.deepEqual(world.messages, [])
})

test("genesis refuses, sending nothing, when only the second admission's quorum is out of reach", async () => {
    const world = setup({ funded: true })
    // Member A is in and seated: Safe [Member A, OWNER] at threshold 2, so Member B needs both, and Member A's key is not held.
    const [memberA] = world.founders
    world.network.approved.add(memberA.networkId)
    world.network.owners = [memberA.governanceSignerAddress, OWNER.address]
    world.network.threshold = 2n
    world.heldKeys = world.heldKeys.filter((key) => key !== memberA.governanceSignerPrivateKey)

    await assert.rejects(
        genesis(world),
        (error: unknown) =>
            error instanceof OperatorError && /admit Member B: the Safe needs 2 approvals.*reach 1/.test(error.message)
    )
    assert.deepEqual(world.network.sent, [])
})

test("genesis admits each founder under the hash of its auth key's public point", async () => {
    const world = setup({ funded: true })

    await genesis(world)

    for (const founder of world.founders) {
        const publicKey = privateKeyToAccount(founder.authPrivateKey).publicKey
        const x = BigInt(`0x${publicKey.slice(4, 68)}`)
        const y = BigInt(`0x${publicKey.slice(68)}`)
        const admitted = world.network.admitted.get(keccak256(encodePacked(["uint256", "uint256"], [x, y])))
        assert.ok(admitted, `${founder.name} is admitted under the hash of its auth key's X and Y`)
        assert.equal(admitted.accountKeyX, x)
        assert.equal(admitted.accountKeyY, y)
        assert.equal(keccak256(encodePacked(["uint256", "uint256"], [x, y])), founder.networkId)
    }
})

test("genesis sends only the execution when every approval is already on chain", async () => {
    const world = setup({ funded: true })
    await settled(world)
    const [memberA, memberB] = world.founders
    world.network.approved.delete(memberB.networkId)
    world.network.admitted.delete(memberB.networkId)
    world.network.issuerKeys.delete(memberB.networkId)
    world.network.paymasterMembers.delete(memberB.semaphoreCommitment)
    world.network.memberLogs = world.network.memberLogs.filter((log) => log.commitment !== memberB.semaphoreCommitment)
    world.network.owners = [memberA.governanceSignerAddress, OWNER.address]
    world.network.threshold = 2n
    world.network.nonce = 1n
    world.network.preapproved.set("1", [OWNER.address, memberA.governanceSignerAddress])

    await genesis(world)

    assert.deepEqual(world.network.kinds("approveHash"), [])
    assert.equal(world.network.kinds("execTransaction").length, 1)
    assert.ok(world.network.approved.has(memberB.networkId))
})

test("genesis stops at a reverted approval and never executes", async () => {
    const world = setup({ funded: true })
    world.network.revertKind = "approveHash"

    await assert.rejects(genesis(world), /admit Member A: approve as 0x[0-9a-fA-F]{40} reverted: 0x/)

    assert.deepEqual(world.network.kinds("execTransaction"), [])
    assert.deepEqual(world.network.kinds("addMember"), [])
})

test("genesis stops at a reverted issuer-key publication before it mirrors anything", async () => {
    const world = setup({ funded: true })
    world.network.revertKind = "publishIssuerKey"

    await assert.rejects(genesis(world), /publish Member A's issuer key reverted: 0x/)

    assert.equal(world.network.kinds("publishIssuerKey").length, 1)
    assert.deepEqual(world.network.kinds("addMember"), [])
})
