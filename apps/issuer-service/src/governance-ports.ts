import {
    BaseError,
    ContractFunctionRevertedError,
    bytesToHex,
    createPublicClient,
    createWalletClient,
    decodeEventLog,
    defineChain,
    getAddress,
    hexToBytes,
    http,
    nonceManager
} from "viem"
import type { Address, Hex, Log } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
    buildAdmissionTransaction,
    checkQuorum,
    decodeJoinRequestLog,
    encodeApproveHash,
    encodeExecTransaction,
    hashSafeTransaction,
    memberAccountKey,
    NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
    NETWORK_MEMBER_REGISTRY_ABI,
    onChainApproval
} from "@coordination-network/network-member-governance"
import type { NetworkMemberJoinRequest, SafeContext } from "@coordination-network/network-member-governance"
import { EventLogIndex, withLogWindow } from "./chain-logs"
import { GovernanceConfig } from "./config"

type NetworkId = GovernanceConfig["networkId"]

const lowercaseHex = (hex: Hex): Hex => bytesToHex(hexToBytes(hex))

/** The `NetworkMemberRegistry` reads and writes this member needs beyond what the governance
 *  package's own ABI covers (that one only carries `requestToJoin` and its event). The errors let
 *  `writeContract` decode a revert into a name (see {@link revertErrorName}) instead of an opaque
 *  one, so the routes can answer 409 for the ones a caller can expect to hit. */
const MEMBER_REGISTRY_ABI = [
    {
        type: "function",
        name: "isApproved",
        stateMutability: "view",
        inputs: [{ name: "memberNetworkId", type: "bytes32" }],
        outputs: [{ type: "bool" }]
    },
    {
        type: "function",
        name: "identity",
        stateMutability: "view",
        inputs: [{ name: "memberNetworkId", type: "bytes32" }],
        outputs: [{ type: "bytes" }]
    },
    {
        type: "function",
        name: "registerNetworkMemberIdentity",
        stateMutability: "nonpayable",
        inputs: [
            { name: "memberNetworkId", type: "bytes32" },
            { name: "newMetaStealthAddress", type: "bytes" }
        ],
        outputs: []
    },
    ...NETWORK_MEMBER_REGISTRY_ABI,
    { type: "error", name: "AlreadyApproved", inputs: [{ name: "memberNetworkId", type: "bytes32" }] },
    { type: "error", name: "NotApproved", inputs: [{ name: "memberNetworkId", type: "bytes32" }] }
] as const

const SAFE_ABI = [
    { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
    { type: "function", name: "getThreshold", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    {
        type: "function",
        name: "approvedHashes",
        stateMutability: "view",
        inputs: [
            { name: "owner", type: "address" },
            { name: "safeTxHash", type: "bytes32" }
        ],
        outputs: [{ type: "uint256" }]
    }
] as const

const APPROVED_ISSUER_SET_ABI = [
    {
        type: "function",
        name: "issuerKeysOf",
        stateMutability: "view",
        inputs: [{ name: "memberNetworkId", type: "bytes32" }],
        outputs: [{ type: "uint256[]" }]
    },
    {
        type: "function",
        name: "publishIssuerKey",
        stateMutability: "nonpayable",
        inputs: [
            { name: "memberNetworkId", type: "bytes32" },
            { name: "publicKeyX", type: "uint256" },
            { name: "publicKeyY", type: "uint256" }
        ],
        outputs: [{ name: "leaf", type: "uint256" }]
    },
    {
        type: "event",
        name: "IssuerKeyPublished",
        inputs: [
            { name: "memberNetworkId", type: "bytes32", indexed: true },
            { name: "leaf", type: "uint256", indexed: false },
            { name: "index", type: "uint256", indexed: false },
            { name: "issuerSetRoot", type: "uint256", indexed: false }
        ]
    },
    { type: "error", name: "IssuerKeyAlreadyPublished", inputs: [{ name: "leaf", type: "uint256" }] }
] as const

/** Where an admission attempt landed. An approval only ever adds this member's own voice, so a Safe
 *  above threshold 1 reports `awaitingApprovals` until enough owners have approved the same hash.
 *  `approveTxHash` is null when this member had already approved it. */
export type AdmissionOutcome =
    | {
          status: "admitted"
          safeTxHash: Hex
          approveTxHash: Hex | null
          execTxHash: Hex
          approvals: number
          threshold: number
      }
    | { status: "awaitingApprovals"; safeTxHash: Hex; approveTxHash: Hex | null; approvals: number; threshold: number }
    | { status: "alreadyApproved" }
    | { status: "noPendingRequest" }

/** What the governance routes need: reads of this member's own membership and the network's
 *  pending requests, and the writes a member makes as a candidate, an approver, or itself. */
export interface GovernancePorts {
    networkId: NetworkId
    authAddress: Address
    governanceSigner: Address
    safeAddress: Address
    metaStealthAddress: Hex
    isApproved(networkId?: NetworkId): Promise<boolean>
    /** The latest `NetworkMemberJoinRequested` log for a networkId, or `null` if it never requested. */
    joinRequestFor(networkId?: NetworkId): Promise<NetworkMemberJoinRequest | null>
    safeState(): Promise<{ owners: Address[]; threshold: number }>
    identityOf(networkId?: NetworkId): Promise<Hex | null>
    issuerKeysOf(networkId?: NetworkId): Promise<bigint[]>
    /** Announces this member's own join request, self-paid from the auth key. */
    requestToJoin(): Promise<Hex>
    /** Every join request across the network whose member isn't already approved. */
    pendingJoinRequests(): Promise<NetworkMemberJoinRequest[]>
    admitMember(networkId: NetworkId): Promise<AdmissionOutcome>
    /** Records this member's own meta-stealth address in the member registry, self-paid from the auth key. */
    registerIdentity(): Promise<Hex>
    publishIssuerKey(x: bigint, y: bigint): Promise<{ txHash: Hex; leaf: bigint; root: bigint }>
}

/** A write reverted with a name the caller can expect and act on (`AlreadyApproved`, `NotApproved`,
 *  `IssuerKeyAlreadyPublished`), decoded from the ABI's own error definitions. The routes match on
 *  `code` to answer 409 instead of letting it fall through as a 500. */
export class GovernanceRevertError extends Error {
    readonly code: string
    // `declare` emits no field: at ES2022 one would be created enumerable, defeating defineProperty.
    declare readonly cause?: unknown

    constructor(code: string, cause?: unknown) {
        super(`governance write reverted: ${code}`)
        this.name = "GovernanceRevertError"
        this.code = code
        if (cause !== undefined) {
            Object.defineProperty(this, "cause", { value: cause, writable: true, configurable: true })
        }
    }
}

/** The revert's decoded error name, if `error` (or something it wraps) is a contract revert. */
function revertErrorName(error: unknown): string | undefined {
    if (!(error instanceof BaseError)) return undefined
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined
}

/** Runs a governance write, turning a decodable revert into a {@link GovernanceRevertError} so the
 *  route layer can answer 409 for the ones a caller can expect to hit. */
async function writeOrDecode<T>(write: () => Promise<T>): Promise<T> {
    try {
        return await write()
    } catch (error) {
        const code = revertErrorName(error)
        throw code !== undefined ? new GovernanceRevertError(code, error) : error
    }
}

/** The `IssuerKeyPublished` fields a publish needs back, decoded from the receipt rather than a
 *  return value: `publishIssuerKey` is a state-mutating call, so a plain write never sees one. */
function decodeIssuerKeyPublished(log: Log): { leaf: bigint; issuerSetRoot: bigint } | undefined {
    try {
        const { args } = decodeEventLog({
            abi: APPROVED_ISSUER_SET_ABI,
            eventName: "IssuerKeyPublished",
            data: log.data,
            topics: log.topics
        })
        return { leaf: args.leaf, issuerSetRoot: args.issuerSetRoot }
    } catch {
        // Not this log: a publish's receipt also carries the underlying ERC-20-free transfer logs
        // (none here) and any other event the same block happened to include.
        return undefined
    }
}

export function buildGovernancePorts(config: GovernanceConfig, rpcUrl: string): GovernancePorts {
    const {
        authPrivateKey,
        governanceSignerPrivateKey,
        networkId,
        semaphoreCommitment,
        metaStealthAddress,
        registry,
        governance,
        safe,
        issuerSet,
        multiSend,
        deployBlock,
        logWindowBlocks,
        logConfirmations,
        metadataURI,
        safeVersion,
        chainId
    } = config

    const chain = defineChain({
        id: chainId,
        name: "issuer-service-governance-chain",
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
    })
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) })
    const authClient = createWalletClient({
        account: privateKeyToAccount(authPrivateKey, { nonceManager }),
        chain,
        transport: http(rpcUrl)
    })
    const governanceSignerAccount = privateKeyToAccount(governanceSignerPrivateKey, { nonceManager })
    const governanceClient = createWalletClient({ account: governanceSignerAccount, chain, transport: http(rpcUrl) })

    const authAddress = authClient.account.address
    const { accountKeyX, accountKeyY } = memberAccountKey(authClient.account.publicKey)
    const governanceSignerAddress = governanceSignerAccount.address
    const context: SafeContext = { safeAddress: safe, chainId, safeVersion, multiSend }

    const isApproved = (id: NetworkId = networkId) =>
        publicClient.readContract({
            address: registry,
            abi: MEMBER_REGISTRY_ABI,
            functionName: "isApproved",
            args: [id]
        })

    // Every status poll asks for these logs; the index reads each block range once.
    const joinRequests = new EventLogIndex({
        fromBlock: BigInt(deployBlock),
        windowBlocks: logWindowBlocks === undefined ? undefined : BigInt(logWindowBlocks),
        confirmations: logConfirmations === undefined ? undefined : BigInt(logConfirmations),
        fetch: async (from, to) => {
            const logs = await publicClient.getLogs({
                address: registry,
                event: NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
                fromBlock: from,
                toBlock: to
            })
            return logs.map((log) => decodeJoinRequestLog(log, registry))
        }
    })
    const syncedJoinRequests = async (): Promise<readonly NetworkMemberJoinRequest[]> =>
        joinRequests.sync(await publicClient.getBlockNumber({ cacheTime: 0 }))

    // A candidate may have published several requests before admission; the approvers' server
    // always builds against the latest one, per contracts/docs/configuration/network-member-onboarding.md's Phase 2.
    const latestRequestFor = (requests: readonly NetworkMemberJoinRequest[], id: Hex) =>
        requests.filter((request) => request.memberNetworkId.toLowerCase() === id).pop() ?? null

    const joinRequestFor = async (id: NetworkId = networkId): Promise<NetworkMemberJoinRequest | null> =>
        latestRequestFor(await syncedJoinRequests(), lowercaseHex(id))

    // An approval signs the request it is built from, so it reads the chain head directly: the
    // index lags by `logConfirmations` and keeps a request a reorg has since dropped.
    const freshJoinRequestFor = async (id: NetworkId): Promise<NetworkMemberJoinRequest | null> => {
        const memberNetworkId = lowercaseHex(id)
        const logs = await withLogWindow(publicClient, logWindowBlocks).getLogs({
            address: registry,
            event: NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
            args: { memberNetworkId },
            fromBlock: BigInt(deployBlock)
        })
        return latestRequestFor(
            logs.map((log) => decodeJoinRequestLog(log, registry)),
            memberNetworkId
        )
    }

    const safeState = async () => {
        const [owners, threshold] = await Promise.all([
            publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: "getOwners" }),
            publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: "getThreshold" })
        ])
        return { owners: [...owners], threshold: Number(threshold) }
    }

    /** Whether `owner` has recorded an `approveHash` for this exact transaction, read from the
     *  Safe's own storage rather than from anything an approver sends round. */
    const hasApproved = async (owner: Address, safeTxHash: Hex): Promise<boolean> => {
        const approved = await publicClient.readContract({
            address: safe,
            abi: SAFE_ABI,
            functionName: "approvedHashes",
            args: [owner, safeTxHash]
        })
        return approved !== 0n
    }

    const identityOf = async (id: NetworkId = networkId): Promise<Hex | null> => {
        const value = await publicClient.readContract({
            address: registry,
            abi: MEMBER_REGISTRY_ABI,
            functionName: "identity",
            args: [id]
        })
        return value === "0x" ? null : value
    }

    const issuerKeysOf = async (id: NetworkId = networkId): Promise<bigint[]> => {
        const leaves = await publicClient.readContract({
            address: issuerSet,
            abi: APPROVED_ISSUER_SET_ABI,
            functionName: "issuerKeysOf",
            args: [id]
        })
        return [...leaves]
    }

    return {
        networkId,
        authAddress,
        governanceSigner: governanceSignerAddress,
        safeAddress: getAddress(safe),
        metaStealthAddress,
        isApproved,
        joinRequestFor,
        safeState,
        identityOf,
        issuerKeysOf,

        async requestToJoin() {
            return writeOrDecode(() =>
                authClient.writeContract({
                    address: registry,
                    abi: MEMBER_REGISTRY_ABI,
                    functionName: "requestToJoin",
                    args: [accountKeyX, accountKeyY, semaphoreCommitment, governanceSignerAddress, metadataURI]
                })
            )
        },

        async pendingJoinRequests() {
            // A candidate may have published several requests before admission (see joinRequestFor
            // above); keep only the latest log per member before checking approval.
            const latest = new Map<Hex, NetworkMemberJoinRequest>()
            for (const request of await syncedJoinRequests()) {
                latest.set(request.memberNetworkId, request)
            }
            const requests = [...latest.values()]
            const approved = await Promise.all(requests.map((request) => isApproved(request.memberNetworkId)))
            return requests.filter((_, index) => !approved[index])
        },

        async admitMember(id) {
            if (await isApproved(id)) return { status: "alreadyApproved" }

            const request = await freshJoinRequestFor(id)
            if (!request) return { status: "noPendingRequest" }

            const [nonce, { owners, threshold }] = await Promise.all([
                publicClient.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" }),
                safeState()
            ])

            // Every owner builds this from the same chain state, so they all reach the same hash and
            // their approvals accumulate against one transaction instead of competing.
            const transaction = buildAdmissionTransaction(
                { governance, registry },
                request,
                context,
                Number(nonce),
                owners.length
            )
            const safeTxHash = hashSafeTransaction(context, transaction)

            // Two transactions on purpose, not a single execTransaction: recording approveHash
            // first is what leaves an ApproveHash event a dashboard can show, and it is what lets
            // the owner that completes the quorum execute on everyone else's behalf.
            let approveTxHash: Hex | null = null
            if (!(await hasApproved(governanceSignerAddress, safeTxHash))) {
                approveTxHash = await governanceClient.sendTransaction({
                    to: getAddress(safe),
                    data: encodeApproveHash(context, safeTxHash)
                })
                const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTxHash })
                if (approveReceipt.status === "reverted") {
                    throw new Error(`approveHash transaction ${approveTxHash} reverted`)
                }
            }

            const approvedBy = await Promise.all(owners.map((owner) => hasApproved(owner, safeTxHash)))
            const quorum = checkQuorum(
                owners,
                threshold,
                owners.filter((_owner, index) => approvedBy[index])
            )
            const approvals = quorum.signers.length
            if (!quorum.hasQuorum) {
                return { status: "awaitingApprovals", safeTxHash, approveTxHash, approvals, threshold }
            }

            const execTxHash = await governanceClient.sendTransaction({
                to: getAddress(safe),
                data: encodeExecTransaction(context, transaction, quorum.signers.map(onChainApproval))
            })
            const execReceipt = await publicClient.waitForTransactionReceipt({ hash: execTxHash })
            if (execReceipt.status === "reverted") {
                throw new Error(`execTransaction transaction ${execTxHash} reverted`)
            }

            return { status: "admitted", safeTxHash, approveTxHash, execTxHash, approvals, threshold }
        },

        async registerIdentity() {
            return writeOrDecode(() =>
                authClient.writeContract({
                    address: registry,
                    abi: MEMBER_REGISTRY_ABI,
                    functionName: "registerNetworkMemberIdentity",
                    args: [networkId, metaStealthAddress]
                })
            )
        },

        async publishIssuerKey(x, y) {
            const hash = await writeOrDecode(() =>
                authClient.writeContract({
                    address: issuerSet,
                    abi: APPROVED_ISSUER_SET_ABI,
                    functionName: "publishIssuerKey",
                    args: [networkId, x, y]
                })
            )
            const receipt = await publicClient.waitForTransactionReceipt({ hash })

            const published = receipt.logs.map(decodeIssuerKeyPublished).find((event) => event !== undefined)
            if (!published) throw new Error(`publishIssuerKey transaction ${hash} did not emit IssuerKeyPublished`)

            return { txHash: hash, leaf: published.leaf, root: published.issuerSetRoot }
        }
    }
}
