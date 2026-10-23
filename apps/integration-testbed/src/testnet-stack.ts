import { existsSync } from "node:fs"
import {
    BaseError,
    ContractFunctionRevertedError,
    ContractFunctionZeroDataError,
    formatEther,
    HttpRequestError,
    nonceManager,
    parseAbi,
    parseAbiItem,
    parseEther,
    type Address,
    type Hex,
    type PublicClient
} from "viem"
import { entryPoint08Address } from "viem/account-abstraction"
import { privateKeyToAccount, type LocalAccount } from "viem/accounts"
import { issuerLeaf } from "@coordination-network/credential"
import {
    governanceThreshold,
    memberAccountKey,
    type SafeVersion
} from "@coordination-network/network-member-governance"
import { withLogWindow } from "../../issuer-service/src/chain-logs"
import { connectToChain, optionalEnvironmentVariable } from "./anvil"
import { ERC5564_ANNOUNCER_ADDRESS, SEMAPHORE_ADDRESS, SIMPLE_7702_ACCOUNT_ADDRESS } from "./config"
import { deploymentFileFor, readDeploymentFile } from "./deployment-file"
import { OperatorError } from "./operator-error"
import { PAYMASTER_GROUP_ABI } from "./paymaster-group"
import { redactUrls } from "./redact-urls"
import { buildMembers, lanAddress, memberSecrets, STACK_PORT, type Member } from "./members"
import type { ResolvedStack } from "./serve"

const DEFAULT_LOG_WINDOW_BLOCKS = 10_000
/** How many blocks a governance event is buried under before the member servers act on it. */
const TESTNET_LOG_CONFIRMATIONS = 2
/** A provider's head moves every few seconds, so the paymaster mirror polls at about a block. */
const TESTNET_MIRROR_POLL_MS = 12_000

/** What genesis tops each account up to, and the balance below which it does. */
export const ORG_ACCOUNT = { floor: parseEther("0.01"), target: parseEther("0.05") }
export const BUNDLER_ACCOUNT = { floor: parseEther("0.05"), target: parseEther("0.2") }
export const PAYMASTER_DEPOSIT_TARGET = parseEther("0.05")
/** Headroom for the gas of genesis's own transactions, on top of what it sends. */
const GENESIS_GAS_MARGIN = parseEther("0.05")

/** Below these the stack starts but a flow stalls on an empty account, so `preflight` refuses. The
 *  org and bundler accounts use the floors above. */
const OWNER_FLOOR = parseEther("0.01")
const PAYMASTER_DEPOSIT_FLOOR = parseEther("0.02")

/** `ApprovedIssuerSet.MAX_ISSUER_KEYS_PER_MEMBER`: a member at the cap cannot publish another. */
export const MAX_ISSUER_KEYS_PER_MEMBER = 8

export const SAFE_ABI = parseAbi([
    "function VERSION() view returns (string)",
    "function getOwners() view returns (address[])",
    "function getThreshold() view returns (uint256)",
    "function isModuleEnabled(address module) view returns (bool)",
    "function nonce() view returns (uint256)",
    "function approvedHashes(address owner, bytes32 hash) view returns (uint256)",
    "function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 nonce) view returns (bytes32)"
])
export const REGISTRY_ABI = parseAbi([
    "function isApproved(bytes32 memberNetworkId) view returns (bool)",
    "function approvedIssuerSet() view returns (address)",
    "function memberNetworkIdOf(uint256 accountKeyX, uint256 accountKeyY) pure returns (bytes32)",
    "function governanceSignerOf(bytes32 memberNetworkId) view returns (address)"
])
export const ISSUER_SET_ABI = parseAbi(["function issuerKeysOf(bytes32 memberNetworkId) view returns (uint256[])"])
const SEMAPHORE_ABI = parseAbi(["function hasMember(uint256 groupId, uint256 identityCommitment) view returns (bool)"])
export const PAYMASTER_ABI = parseAbi([
    "function getDeposit() view returns (uint256)",
    "function getGroupAdmin(uint256 groupId) view returns (address)"
])
const GOVERNANCE_SIGNER_PUBLISHED_EVENT = parseAbiItem(
    "event GovernanceSignerPublished(bytes32 indexed memberNetworkId, address indexed governanceSigner)"
)

/** A `ResolvedStack` for a public chain, which also carries the bundler's own account: the stack
 *  does not fund a fresh one there. */
export interface TestnetStack extends ResolvedStack {
    bundlerAccount: LocalAccount
    logWindowBlocks: number
    logConfirmations: number
}

/** Whether `override` repeats a part of `upstream` that carries the provider key: its hostname (a key
 *  can be a host label), its password, its path or its query. Encoded forms are compared as written. */
function carriesProviderKey(override: string, upstream: string): boolean {
    let parsed: URL
    try {
        parsed = new URL(upstream)
    } catch {
        return false
    }
    let overrideHostname = ""
    try {
        overrideHostname = new URL(override).hostname.toLowerCase()
    } catch {
        // Not a URL: only the path, query and password can still be found in its text.
    }
    const text = override.toLowerCase()
    const hostname = parsed.hostname.toLowerCase()
    const password = parsed.password.toLowerCase()
    const credentials = `${parsed.username}:${parsed.password}`.toLowerCase()
    const path = parsed.pathname.toLowerCase()
    return (
        (hostname !== "" && overrideHostname.includes(hostname)) ||
        (password !== "" && (text.includes(password) || text.includes(credentials))) ||
        (path.length > 1 && text.includes(path)) ||
        (parsed.search !== "" && text.includes(parsed.search.toLowerCase()))
    )
}

/** What `stack.json` tells the phones to use instead of this stack's own proxy, when the operator set one. */
export function publicRpcOverride(): string | undefined {
    const override = optionalEnvironmentVariable("STACK_PUBLIC_RPC_URL")
    const upstream = optionalEnvironmentVariable("RPC_URL")
    if (override !== undefined && upstream !== undefined && carriesProviderKey(override, upstream)) {
        throw new OperatorError(
            "STACK_PUBLIC_RPC_URL repeats RPC_URL's hostname, password, path or query; that would put the provider key in stack.json, which every phone reads"
        )
    }
    return override
}

/** The leaf `issuerKeysOf` lists once the member has published its own signing key. */
export async function issuerLeafOf(member: Member): Promise<bigint> {
    return issuerLeaf(await member.signer.getPublicKey())
}

/** The account key the registry derives `memberNetworkId` from: the auth key's public coordinates. */
export function accountKeyOf(member: Member): ReturnType<typeof memberAccountKey> {
    return memberAccountKey(privateKeyToAccount(member.authPrivateKey).publicKey)
}

export function issuerKeyCapMessage(member: Member, published: number): string {
    return `${member.name} already has ${published} issuer keys published and none is the one derived from its seed; the set takes no more`
}

function bundlerAccount(): LocalAccount {
    const setting = optionalEnvironmentVariable("STACK_BUNDLER_PRIVATE_KEY")
    if (setting === undefined) {
        throw new OperatorError(
            "STACK_BUNDLER_PRIVATE_KEY must be set in testnet mode: a 32-byte hex key, used for the bundler's gas only"
        )
    }
    const digits = setting.trim().replace(/^0x/, "")
    if (!/^[0-9a-fA-F]{64}$/.test(digits)) {
        throw new OperatorError("STACK_BUNDLER_PRIVATE_KEY must be a 32-byte hex private key")
    }
    return privateKeyToAccount(`0x${digits}`, { nonceManager })
}

/** The stack's view of a network that is already deployed: the deployment file, the third-party
 *  contracts every chain shares, and the demo orgs keyed from `STACK_MEMBER_SEEDS`. */
export async function resolveTestnetStack(diagnostic: (message: string) => void): Promise<TestnetStack> {
    if (optionalEnvironmentVariable("STACK_MEMBER_SEEDS") === undefined) {
        throw new OperatorError(
            "STACK_MEMBER_SEEDS must be set in testnet mode: three comma-separated 32-byte hex seeds"
        )
    }
    const secrets = memberSecrets()
    const account = bundlerAccount()
    const publicRpcUrl = publicRpcOverride()

    const chain = await connectToChain(diagnostic)
    const chainId = chain.chainDefinition.id
    const members = buildMembers(secrets, chainId)
    const deploymentFile = deploymentFileFor(optionalEnvironmentVariable("DEPLOYMENT_FILE"), chainId)
    if (!existsSync(deploymentFile)) {
        throw new OperatorError(`no deployment file at ${deploymentFile}; deploy first, or set DEPLOYMENT_FILE`)
    }
    const deployed = readDeploymentFile(deploymentFile)
    const safeVersion = (await chain.publicClient
        .readContract({ address: deployed.governanceSafe, abi: SAFE_ABI, functionName: "VERSION" })
        .catch((error: unknown) => {
            // Only an address with no contract points at the wrong chain; a refused or dropped request says nothing about it.
            const noContract = error instanceof BaseError && error.walk(isEmptyAnswer) !== null
            throw new OperatorError(
                noContract
                    ? `no Safe answers at ${deployed.governanceSafe} on chain ${chainId} (${describeFailure(error)}); is ${deploymentFile} for another chain?`
                    : `could not read the Safe at ${deployed.governanceSafe} on chain ${chainId}: ${describeFailure(error)}`
            )
        })) as SafeVersion

    const logWindowSetting = optionalEnvironmentVariable("STACK_LOG_WINDOW_BLOCKS")
    const logWindowBlocks = logWindowSetting === undefined ? DEFAULT_LOG_WINDOW_BLOCKS : Number(logWindowSetting)
    if (!Number.isInteger(logWindowBlocks) || logWindowBlocks < 1) {
        throw new OperatorError(`STACK_LOG_WINDOW_BLOCKS must be a positive integer, got "${logWindowSetting}"`)
    }
    diagnostic(`Deployment ${deploymentFile}; bundler account ${account.address}`)

    return {
        chain,
        addresses: {
            identityRegistry: deployed.identityRegistry,
            announcer: ERC5564_ANNOUNCER_ADDRESS,
            revocation: deployed.revocation,
            credentialRevocationRegistry: deployed.credentialRevocationRegistry,
            credentialRevocationRegistryId: deployed.credentialRevocationRegistryId,
            semaphore: SEMAPHORE_ADDRESS,
            networkMemberRegistry: deployed.networkMemberRegistry,
            networkMemberGroup: deployed.networkMemberGroup,
            networkMemberGovernance: deployed.networkMemberGovernance,
            approvedIssuerSet: deployed.approvedIssuerSet,
            governanceSafe: deployed.governanceSafe,
            entryPoint: entryPoint08Address,
            paymaster: deployed.semaphorePaymaster,
            accountImplementation: SIMPLE_7702_ACCOUNT_ADDRESS
        },
        deployBlock: deployed.blockNumber,
        groupId: deployed.networkMemberGroupId,
        safeVersion,
        chainId: deployed.chainId,
        members,
        logWindowBlocks,
        logConfirmations: TESTNET_LOG_CONFIRMATIONS,
        publicRpcUrl: publicRpcUrl ?? `http://${lanAddress()}:${STACK_PORT}`,
        paymasterMirror: {
            paymaster: { abi: PAYMASTER_GROUP_ABI, address: deployed.semaphorePaymaster },
            group: { abi: [], address: deployed.networkMemberGroup },
            // The paymaster's group is created in its constructor, no earlier than the deployment's first block.
            paymasterGroupFromBlock: deployed.blockNumber,
            pollingIntervalMs: TESTNET_MIRROR_POLL_MS
        },
        bundlerAccount: account
    }
}

type PreflightClient = Pick<
    PublicClient,
    "getBalance" | "getBlockNumber" | "getChainId" | "getCode" | "getLogs" | "readContract"
>

/** `serve` checks everything the stack needs to run; `genesis` only what it needs to set the rest up. */
type PreflightScope = "serve" | "genesis"

/** The contract answered, with a revert or with nothing: it is there, and does not do what was asked. */
function isEmptyAnswer(error: unknown): boolean {
    return error instanceof ContractFunctionRevertedError || error instanceof ContractFunctionZeroDataError
}

/** One line for a failed read: viem's short message, the HTTP status and the provider's own words,
 *  which its generic first line leaves out (a block-range cap, a rate limit). */
function describeFailure(error: unknown): string {
    if (!(error instanceof BaseError)) {
        return redactUrls((error instanceof Error ? error.message : String(error)).split("\n")[0])
    }
    const parts: string[] = []
    for (let link: unknown = error; link instanceof BaseError; link = "cause" in link ? link.cause : undefined) {
        parts.push(link.shortMessage)
        if (link instanceof HttpRequestError && link.status !== undefined) parts.push(`HTTP ${link.status}`)
        if (link.details) parts.push(link.details)
    }
    return redactUrls([...new Set(parts)].join("; ").replace(/\s*\n\s*/g, " "))
}

const sameAddress = (a: Address, b: Address) => a.toLowerCase() === b.toLowerCase()

export async function readSafeState(client: PreflightClient, safe: Address) {
    const [owners, threshold] = await Promise.all([
        client.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" }),
        client.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" })
    ])
    return { owners, threshold }
}

export function readIsApproved(client: PreflightClient, registry: Address, networkId: Hex) {
    return client.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "isApproved",
        args: [networkId]
    })
}

export function readIssuerKeys(client: PreflightClient, issuerSet: Address, networkId: Hex) {
    return client.readContract({
        address: issuerSet,
        abi: ISSUER_SET_ABI,
        functionName: "issuerKeysOf",
        args: [networkId]
    })
}

function readGovernanceSigner(client: PreflightClient, registry: Address, networkId: Hex) {
    return client.readContract({
        address: registry,
        abi: REGISTRY_ABI,
        functionName: "governanceSignerOf",
        args: [networkId]
    })
}

export function readPaymasterDeposit(client: PreflightClient, paymaster: Address) {
    return client.readContract({ address: paymaster, abi: PAYMASTER_ABI, functionName: "getDeposit" })
}

/**
 * Reads the deployment and reports, in one error with one line per problem, everything that would
 * stop the stack from serving it (`serve`) or genesis from setting it up (`genesis`). Read-only: it
 * never sends a transaction. `heldAddresses` are the keys genesis holds.
 */
export async function preflight(
    stack: TestnetStack,
    client: PreflightClient,
    scope: PreflightScope,
    heldAddresses: Address[] = []
): Promise<{ warnings: string[] }> {
    const { addresses, members, chain } = stack
    const founders = members.filter((member) => member.role === "founder")
    const candidates = members.filter((member) => member.role === "candidate")
    const owner = chain.deployer
    const warnings: string[] = []

    /** Runs one check; a read that throws is a failure line, not a reason to skip the rest. */
    const check = async (label: string, run: () => Promise<string | undefined>): Promise<string[]> => {
        try {
            const failure = await run()
            return failure === undefined ? [] : [failure]
        } catch (error) {
            return [`${label}: ${describeFailure(error)}`]
        }
    }
    const balanceAtLeast = (label: string, address: Address, floor: bigint, refilledByGenesis = true) =>
        check(label, async () => {
            const balance = await client.getBalance({ address })
            return balance < floor
                ? `${label} ${address} holds ${formatEther(balance)} ETH, below ${formatEther(floor)} ETH` +
                      (refilledByGenesis ? "; run yarn stack:genesis to refill" : "")
                : undefined
        })
    const safeState = () => readSafeState(client, addresses.governanceSafe)
    const isApproved = (member: Member) => readIsApproved(client, addresses.networkMemberRegistry, member.networkId)
    const issuerKeysOf = (member: Member) => readIssuerKeys(client, addresses.approvedIssuerSet, member.networkId)

    const checks: Promise<string[]>[] = [
        check("chain id", async () => {
            const rpcChainId = await client.getChainId()
            return rpcChainId === stack.chainId
                ? undefined
                : `chain id: the RPC reports ${rpcChainId}, the deployment file says ${stack.chainId}`
        }),
        ...Object.entries(addresses)
            .filter((entry): entry is [string, Address] => typeof entry[1] === "string")
            .map(([name, address]) =>
                check(name, async () =>
                    (await client.getCode({ address })) ? undefined : `no contract code at ${name} ${address}`
                )
            ),
        check("registry", async () => {
            const lines: string[] = []
            for (const member of founders) {
                const { accountKeyX, accountKeyY } = accountKeyOf(member)
                let derived: string
                try {
                    derived = await client.readContract({
                        address: addresses.networkMemberRegistry,
                        abi: REGISTRY_ABI,
                        functionName: "memberNetworkIdOf",
                        args: [accountKeyX, accountKeyY]
                    })
                } catch (error) {
                    if (!(error instanceof BaseError && error.walk(isEmptyAnswer) !== null)) throw error
                    return `registry ${addresses.networkMemberRegistry} has no memberNetworkIdOf: deployment predates the account-key contracts, point DEPLOYMENT_FILE at a deployment of this branch`
                }
                if (derived !== member.networkId) {
                    lines.push(
                        `registry ${addresses.networkMemberRegistry} derives ${derived} from ${member.name}'s account key, the stack's networkId for it is ${member.networkId}`
                    )
                }
            }
            return lines.join("\n") || undefined
        }),
        check("Safe module", async () => {
            const enabled = await client.readContract({
                address: addresses.governanceSafe,
                abi: SAFE_ABI,
                functionName: "isModuleEnabled",
                args: [addresses.networkMemberGovernance]
            })
            return enabled
                ? undefined
                : `Safe ${addresses.governanceSafe}: governance module ${addresses.networkMemberGovernance} is not enabled; run ConfigureGovernance (deployAndConfigureAll does)`
        }),
        check("registry wiring", async () => {
            const wired = await client.readContract({
                address: addresses.networkMemberRegistry,
                abi: REGISTRY_ABI,
                functionName: "approvedIssuerSet"
            })
            return sameAddress(wired, addresses.approvedIssuerSet)
                ? undefined
                : `registry ${addresses.networkMemberRegistry}: approvedIssuerSet is ${wired}, the deployment file says ${addresses.approvedIssuerSet}; run ConfigureGovernance (deployAndConfigureAll does)`
        }),
        // Anyone can deposit for the paymaster, so only the group's admin matters: `addMember` and
        // `removeMember` ask for it, and an ownership transfer does not move it.
        check("paymaster group admin", async () => {
            const groupId = await client.readContract({
                address: addresses.paymaster,
                abi: PAYMASTER_GROUP_ABI,
                functionName: "GROUP_ID"
            })
            const admin = await client.readContract({
                address: addresses.paymaster,
                abi: PAYMASTER_ABI,
                functionName: "getGroupAdmin",
                args: [groupId]
            })
            return sameAddress(admin, owner)
                ? undefined
                : `paymaster group ${groupId} admin is ${admin}, OWNER is ${owner}; genesis and the mirror add and remove members as OWNER`
        }),
        check("Safe threshold", async () => {
            const { owners, threshold } = await safeState()
            const rule = governanceThreshold(owners.length)
            return threshold === BigInt(rule)
                ? undefined
                : `Safe ${addresses.governanceSafe}: threshold is ${threshold} for ${owners.length} owner(s), the governance rule gives ${rule}; the owners restore it with the Safe's changeThreshold`
        }),
        ...founders.map((member) =>
            check(`${member.name} governance signer`, async () => {
                if (!(await isApproved(member))) return undefined
                const signer = await readGovernanceSigner(client, addresses.networkMemberRegistry, member.networkId)
                return sameAddress(signer, member.governanceSignerAddress)
                    ? undefined
                    : `${member.name}: the registry's governance signer is ${signer}, the one derived from its seed is ${member.governanceSignerAddress}; was this seed used as the founding member's secret?`
            })
        ),
        check("eth_getLogs", async () => {
            const window = BigInt(stack.logWindowBlocks)
            try {
                // A provider may refuse a block above its head, which a fresh deployment's window still is.
                const head = await client.getBlockNumber()
                const toBlock = stack.deployBlock + window - 1n
                await client.getLogs({
                    address: addresses.networkMemberRegistry,
                    fromBlock: stack.deployBlock,
                    toBlock: toBlock < head ? toBlock : head
                })
            } catch (error) {
                return `eth_getLogs over ${window} blocks from ${stack.deployBlock} was refused: ${describeFailure(error)}`
            }
            return undefined
        })
    ]

    if (scope === "genesis") {
        checks.push(
            check("held keys", async () => {
                // Only an admission needs the held keys to sign; a network genesis has finished does not.
                const approvals = await Promise.all(founders.map(isApproved))
                if (approvals.every(Boolean)) return undefined
                const { owners, threshold } = await safeState()
                const reached = owners.filter((address) => heldAddresses.some((held) => sameAddress(held, address)))
                return reached.length >= Number(threshold)
                    ? undefined
                    : `the Safe needs ${threshold} approvals and the held keys own ${reached.length} of its ${owners.length} seat(s)`
            }),
            check("OWNER seat", async () => {
                // OWNER signs only the admissions still to make; a refill-only rerun does not need its seat.
                if ((await Promise.all(founders.map(isApproved))).every(Boolean)) return undefined
                const admitted = await withLogWindow(client, stack.logWindowBlocks).getLogs({
                    address: addresses.networkMemberRegistry,
                    event: GOVERNANCE_SIGNER_PUBLISHED_EVENT,
                    args: { governanceSigner: owner },
                    fromBlock: stack.deployBlock,
                    strict: true
                })
                for (const { args } of admitted) {
                    if (!sameAddress(args.governanceSigner, owner)) continue
                    const [approved, signer] = await Promise.all([
                        readIsApproved(client, addresses.networkMemberRegistry, args.memberNetworkId),
                        readGovernanceSigner(client, addresses.networkMemberRegistry, args.memberNetworkId)
                    ])
                    if (approved && sameAddress(signer, owner)) return undefined
                }
                return `OWNER ${owner} is no approved member's governance signer; deploy with deployAndConfigureAll, which admits a founding member seated at OWNER`
            }),
            ...founders.map((member) =>
                check(`${member.name} issuer keys`, async () => {
                    const [keys, leaf] = await Promise.all([issuerKeysOf(member), issuerLeafOf(member)])
                    return !keys.includes(leaf) && keys.length >= MAX_ISSUER_KEYS_PER_MEMBER
                        ? issuerKeyCapMessage(member, keys.length)
                        : undefined
                })
            ),
            check("OWNER balance", async () => {
                const accounts: (readonly [Address, { floor: bigint; target: bigint }])[] = [
                    ...members.map((member) => [member.authAddress, ORG_ACCOUNT] as const),
                    ...founders.map((member) => [member.governanceSignerAddress, ORG_ACCOUNT] as const),
                    [stack.bundlerAccount.address, BUNDLER_ACCOUNT]
                ]
                let topUps = 0n
                for (const [address, { floor, target }] of accounts) {
                    const balance = await client.getBalance({ address })
                    if (balance < floor) topUps += target - balance
                }
                const deposit = await readPaymasterDeposit(client, addresses.paymaster)
                if (deposit < PAYMASTER_DEPOSIT_TARGET) topUps += PAYMASTER_DEPOSIT_TARGET - deposit

                const needed = topUps + GENESIS_GAS_MARGIN
                const balance = await client.getBalance({ address: owner })
                return balance < needed
                    ? `OWNER ${owner} holds ${formatEther(balance)} ETH, below the ${formatEther(needed)} ETH this run needs (${formatEther(topUps)} ETH of top-ups and ${formatEther(GENESIS_GAS_MARGIN)} ETH for gas)`
                    : undefined
            })
        )
    }

    if (scope === "serve") {
        checks.push(
            ...founders.flatMap((member) => [
                check(`${member.name} approval`, async () =>
                    (await isApproved(member))
                        ? undefined
                        : `${member.name}: networkId ${member.networkId} is not approved on the registry`
                ),
                check(`${member.name} member group`, async () =>
                    (await client.readContract({
                        address: addresses.semaphore,
                        abi: SEMAPHORE_ABI,
                        functionName: "hasMember",
                        args: [stack.groupId, member.semaphoreCommitment]
                    }))
                        ? undefined
                        : `${member.name}: commitment is not in the approved-member group ${stack.groupId}`
                ),
                check(`${member.name} paymaster group`, async () => {
                    const inGroup = await client.readContract({
                        address: addresses.paymaster,
                        abi: SEMAPHORE_ABI,
                        functionName: "hasMember",
                        args: [
                            await client.readContract({
                                address: addresses.paymaster,
                                abi: PAYMASTER_GROUP_ABI,
                                functionName: "GROUP_ID"
                            }),
                            member.semaphoreCommitment
                        ]
                    })
                    if (!inGroup) {
                        warnings.push(
                            `${member.name}: commitment is not in the paymaster group; the mirror adds it at start, before serving`
                        )
                    }
                    return undefined
                }),
                check(`${member.name} issuer key`, async () => {
                    const [keys, leaf] = await Promise.all([issuerKeysOf(member), issuerLeafOf(member)])
                    if (keys.includes(leaf)) return undefined
                    return keys.length === 0
                        ? `${member.name}: no issuer key published; run yarn stack:genesis to publish it`
                        : `${member.name}: ${keys.length} issuer key(s) published, none is the signing key derived from its seed; run yarn stack:genesis to publish it`
                })
            ]),
            check("Safe owners", async () => {
                const { owners, threshold } = await safeState()
                const lowered = owners.map((address) => address.toLowerCase())
                const seatless = founders.filter(
                    (member) => !lowered.includes(member.governanceSignerAddress.toLowerCase())
                )
                const approved = new Set(
                    (
                        await Promise.all(
                            seatless.map(async (member) => ((await isApproved(member)) ? member : undefined))
                        )
                    )
                        .filter((member) => member !== undefined)
                        .map((member) => member.networkId)
                )
                // Distinct signers: two members sharing one signer are one vote, not two. The candidate
                // counts once it owns a seat, so a Safe grown by its admission still has enough votes.
                const seats = new Set(
                    members
                        .map((member) => member.governanceSignerAddress.toLowerCase())
                        .filter((signer) => lowered.includes(signer))
                ).size
                // Flows 1-5 never touch the Safe, so a grown network serves; only the admission story needs the votes.
                if (seatless.length === 0 && seats < Number(threshold)) {
                    warnings.push(
                        `the stack's members own ${seats} of the ${threshold} approvals the Safe needs; the Safe's other owners must approve, so admissions are beyond the stack`
                    )
                }
                return (
                    seatless
                        .map((member) =>
                            approved.has(member.networkId)
                                ? `${member.name}: governance signer ${member.governanceSignerAddress} is not a Safe owner; its seat was removed through the Safe, and genesis cannot restore it`
                                : `${member.name}: governance signer ${member.governanceSignerAddress} is not a Safe owner; run genesis to seat it`
                        )
                        .join("\n") || undefined
                )
            }),
            ...candidates.map((member) =>
                check(`${member.name} approval`, async () => {
                    if (await isApproved(member)) {
                        warnings.push(
                            `${member.name} is already approved; the admission story has been played on this deployment`
                        )
                    }
                    return undefined
                })
            ),
            ...members.map((member) =>
                balanceAtLeast(`${member.name} auth account`, member.authAddress, ORG_ACCOUNT.floor)
            ),
            ...founders.map((member) =>
                balanceAtLeast(`${member.name} governance signer`, member.governanceSignerAddress, ORG_ACCOUNT.floor)
            ),
            balanceAtLeast("OWNER", owner, OWNER_FLOOR, false),
            balanceAtLeast("bundler", stack.bundlerAccount.address, BUNDLER_ACCOUNT.floor),
            check("paymaster deposit", async () => {
                const deposit = await readPaymasterDeposit(client, addresses.paymaster)
                return deposit < PAYMASTER_DEPOSIT_FLOOR
                    ? `paymaster deposit at the EntryPoint is ${formatEther(deposit)} ETH, below ${formatEther(PAYMASTER_DEPOSIT_FLOOR)} ETH; run yarn stack:genesis to refill`
                    : undefined
            })
        )
    }

    const failures = (await Promise.all(checks)).flat()
    if (failures.length > 0) throw new OperatorError(failures.join("\n"))

    return { warnings }
}
