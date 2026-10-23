import { BaseError, ContractFunctionRevertedError } from "viem"
import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from "viem"
import type { Hex32 } from "@coordination-network/credential"
import type { ContractLeafReader } from "@coordination-network/issuer-set"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { generateRevocationProof, generateSemaphoreProof } from "@coordination-network/network-member-proof"
import type {
    IdentityUpdate,
    NetworkMemberProof,
    RegistryLocation,
    RevocationUpdate
} from "@coordination-network/network-member-proof"
import { NetworkMemberClientError, RegistryRevertError } from "./errors"
import type {
    Announcement,
    AnnouncementSubmitter,
    GroupMirror,
    IdentityReader,
    RegistrationProver,
    RegistrationWrite,
    RegistrationWriter,
    RevocationProver
} from "./types"

/** Shared with `sponsored.ts`: encoding the same call and decoding the same reverts from two writers must not drift apart. */
export const IDENTITY_REGISTRY_ABI = [
    {
        type: "function",
        name: "identity",
        stateMutability: "view",
        inputs: [{ name: "networkId", type: "bytes32" }],
        outputs: [{ type: "bytes" }]
    },
    {
        type: "function",
        name: "registerIdentity",
        stateMutability: "nonpayable",
        inputs: [
            { name: "networkId", type: "bytes32" },
            { name: "metaStealthAddress", type: "bytes" },
            {
                name: "proof",
                type: "tuple",
                components: [
                    { name: "merkleTreeDepth", type: "uint256" },
                    { name: "merkleTreeRoot", type: "uint256" },
                    { name: "nullifier", type: "uint256" },
                    { name: "scope", type: "uint256" },
                    { name: "points", type: "uint256[8]" }
                ]
            }
        ],
        outputs: []
    },
    { type: "error", name: "AlreadyRegistered", inputs: [{ name: "networkId", type: "bytes32" }] },
    { type: "error", name: "InvalidMetaStealthAddressLength", inputs: [] },
    { type: "error", name: "NotRegistered", inputs: [{ name: "networkId", type: "bytes32" }] },
    { type: "error", name: "Semaphore__GroupHasNoMembers", inputs: [] },
    { type: "error", name: "Semaphore__MerkleTreeDepthIsNotSupported", inputs: [] },
    { type: "error", name: "Semaphore__MerkleTreeRootIsExpired", inputs: [] },
    { type: "error", name: "Semaphore__MerkleTreeRootIsNotPartOfTheGroup", inputs: [] },
    { type: "error", name: "Semaphore__YouAreUsingTheSameNullifierTwice", inputs: [] },
    { type: "error", name: "Semaphore__InvalidProof", inputs: [] }
] as const

/** The four Semaphore group-membership events a mirror replays, in the order emission can produce them. */
const SEMAPHORE_GROUP_EVENTS = [
    {
        type: "event",
        name: "MemberAdded",
        inputs: [
            { name: "groupId", type: "uint256", indexed: true },
            { name: "index", type: "uint256", indexed: false },
            { name: "identityCommitment", type: "uint256", indexed: false },
            { name: "merkleTreeRoot", type: "uint256", indexed: false }
        ]
    },
    {
        type: "event",
        name: "MembersAdded",
        inputs: [
            { name: "groupId", type: "uint256", indexed: true },
            { name: "startIndex", type: "uint256", indexed: false },
            { name: "identityCommitments", type: "uint256[]", indexed: false },
            { name: "merkleTreeRoot", type: "uint256", indexed: false }
        ]
    },
    {
        type: "event",
        name: "MemberUpdated",
        inputs: [
            { name: "groupId", type: "uint256", indexed: true },
            { name: "index", type: "uint256", indexed: false },
            { name: "identityCommitment", type: "uint256", indexed: false },
            { name: "newIdentityCommitment", type: "uint256", indexed: false },
            { name: "merkleTreeRoot", type: "uint256", indexed: false }
        ]
    },
    {
        type: "event",
        name: "MemberRemoved",
        inputs: [
            { name: "groupId", type: "uint256", indexed: true },
            { name: "index", type: "uint256", indexed: false },
            { name: "identityCommitment", type: "uint256", indexed: false },
            { name: "merkleTreeRoot", type: "uint256", indexed: false }
        ]
    }
] as const

/** The `ISemaphoreGroups` slice a group mirror needs: the four membership events plus the live root. */
const SEMAPHORE_GROUPS_ABI = [
    ...SEMAPHORE_GROUP_EVENTS,
    {
        type: "function",
        name: "getMerkleTreeRoot",
        stateMutability: "view",
        inputs: [{ name: "groupId", type: "uint256" }],
        outputs: [{ type: "uint256" }]
    }
] as const

/** Whether a replayed leaf array has no gaps: every index up to the highest one seen was set. */
function isDense(leaves: (bigint | undefined)[]): leaves is bigint[] {
    return leaves.every((leaf) => leaf !== undefined)
}

/** The revert's decoded error name, if `error` (or something it wraps) is a contract revert.
 *  Shared with `sponsored-revocation.ts`, whose direct writer walks the same viem error shape. */
export function revertErrorName(error: unknown): string | undefined {
    if (!(error instanceof BaseError)) return undefined
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined
}

/**
 * Chain-backed IdentityReader over `IdentityRegistry`'s public `identity` mapping. Each read puts
 * the recipient's networkId in `eth_call` calldata, visible to whoever serves the RPC.
 */
export class IdentityRegistryClient implements IdentityReader {
    constructor(
        readonly registryAddress: Address,
        private readonly client: Pick<PublicClient, "readContract">
    ) {}

    async getIdentity(networkId: Hex): Promise<Hex | null> {
        const metaStealthAddress = await this.client.readContract({
            address: this.registryAddress,
            abi: IDENTITY_REGISTRY_ABI,
            functionName: "identity",
            args: [networkId]
        })

        return metaStealthAddress === "0x" ? null : metaStealthAddress
    }
}

const APPROVED_ISSUER_SET_ABI = [
    {
        type: "function",
        name: "getLeafCount",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "uint256" }]
    },
    {
        type: "function",
        name: "getLeaves",
        stateMutability: "view",
        inputs: [
            { name: "start", type: "uint256" },
            { name: "end", type: "uint256" }
        ],
        outputs: [{ name: "leaves", type: "uint256[]" }]
    }
] as const

/**
 * Chain-backed ContractLeafReader over ApprovedIssuerSet's paging getters. Reads are pinned to
 * the block observed at `getLeafCount`, so a multi-page rebuild can't mix chain states into a
 * root that never existed; serve one rebuild at a time per instance.
 */
export class ApprovedIssuerSetClient implements ContractLeafReader {
    private blockNumber?: bigint

    constructor(
        private readonly setAddress: Address,
        private readonly client: Pick<PublicClient, "readContract" | "getBlockNumber">
    ) {}

    async getLeafCount(): Promise<bigint> {
        this.blockNumber = await this.client.getBlockNumber()

        return this.client.readContract({
            address: this.setAddress,
            abi: APPROVED_ISSUER_SET_ABI,
            functionName: "getLeafCount",
            blockNumber: this.blockNumber
        })
    }

    async getLeaves(start: number, end: number): Promise<bigint[]> {
        const leaves = await this.client.readContract({
            address: this.setAddress,
            abi: APPROVED_ISSUER_SET_ABI,
            functionName: "getLeaves",
            args: [BigInt(start), BigInt(end)],
            blockNumber: this.blockNumber
        })

        return [...leaves]
    }
}

export const ERC5564_ANNOUNCER_ABI = [
    {
        type: "function",
        name: "announce",
        stateMutability: "nonpayable",
        inputs: [
            { name: "schemeId", type: "uint256" },
            { name: "stealthAddress", type: "address" },
            { name: "ephemeralPubKey", type: "bytes" },
            { name: "metadata", type: "bytes" }
        ],
        outputs: []
    }
] as const

/** Chain-backed AnnouncementSubmitter over `ERC5564Announcer.announce`. */
export class ERC5564AnnouncerClient implements AnnouncementSubmitter {
    constructor(
        private readonly announcerAddress: Address,
        private readonly walletClient: Pick<WalletClient<Transport, Chain, Account>, "writeContract">
    ) {}

    async announce(announcement: Announcement): Promise<Hex> {
        return this.walletClient.writeContract({
            address: this.announcerAddress,
            abi: ERC5564_ANNOUNCER_ABI,
            functionName: "announce",
            args: [
                BigInt(announcement.schemeId),
                announcement.stealthAddress,
                announcement.ephemeralPublicKey,
                announcement.metadata
            ]
        })
    }
}

/**
 * Chain-backed GroupMirror over Semaphore's own group events. Rebuilds the approved-member group
 * by replaying every MemberAdded/MembersAdded/MemberUpdated/MemberRemoved event for `groupId` in
 * emission order, pinned to one `getBlockNumber` so the replay and the root check below can't
 * straddle two chain states. A removal zeroes its leaf rather than deleting it, since Semaphore
 * never reuses an index, so the replay must carry the zero forward into the rebuilt tree.
 *
 * The rebuilt root is then checked against `getMerkleTreeRoot` at that same block: a mismatch
 * means the replay is wrong, not that membership is false, and this is what makes that loud
 * instead of silently producing a proof nothing will accept.
 */
export class SemaphoreGroupClient implements GroupMirror {
    private readonly fromBlock: bigint

    constructor(
        private readonly semaphoreAddress: Address,
        private readonly groupId: bigint,
        private readonly client: Pick<PublicClient, "getBlockNumber" | "getLogs" | "readContract">,
        { fromBlock = 0n }: { fromBlock?: bigint } = {}
    ) {
        this.fromBlock = fromBlock
    }

    async currentGroup(): Promise<Group> {
        try {
            // viem caches getBlockNumber for `pollingInterval`, so two calls made in quick
            // succession — as a caller re-mirroring right after its own write — can otherwise
            // return the same stale height and silently miss that write's own group event.
            const toBlock = await this.client.getBlockNumber({ cacheTime: 0 })
            const [leaves, onChainRoot] = await Promise.all([
                this.replayLeaves(toBlock),
                this.client.readContract({
                    address: this.semaphoreAddress,
                    abi: SEMAPHORE_GROUPS_ABI,
                    functionName: "getMerkleTreeRoot",
                    args: [this.groupId],
                    blockNumber: toBlock
                })
            ])

            if (leaves.length === 0) {
                throw new NetworkMemberClientError(
                    "GROUP_MIRROR_UNAVAILABLE",
                    `no membership events for group ${this.groupId} at ${this.semaphoreAddress}; wrong group id, wrong Semaphore address, or fromBlock past the first admission`
                )
            }
            if (!isDense(leaves)) {
                const missing: number[] = []
                let holeCount = 0
                for (let index = 0; index < leaves.length; index += 1) {
                    if (leaves[index] === undefined) {
                        holeCount += 1
                        if (missing.length < 10) missing.push(index)
                    }
                }
                throw new NetworkMemberClientError(
                    "GROUP_MIRROR_UNAVAILABLE",
                    `group ${this.groupId} replay is missing ${holeCount} leaf index(es), starting with ${missing.join(", ")}; fromBlock is likely later than the first admission`
                )
            }

            const group = new Group(leaves)
            if (BigInt(group.root) !== onChainRoot) {
                throw new NetworkMemberClientError(
                    "GROUP_MIRROR_UNAVAILABLE",
                    `rebuilt group root does not match the chain's for group ${this.groupId}`
                )
            }
            return group
        } catch (error) {
            if (error instanceof NetworkMemberClientError) throw error
            throw new NetworkMemberClientError(
                "GROUP_MIRROR_UNAVAILABLE",
                `failed to rebuild the approved-member group ${this.groupId}`,
                error
            )
        }
    }

    /** Replays the four membership events into a dense, index-ordered leaf array. `undefined`
     *  marks an index no admission log ever set, so a hole can't silently pass as leaf `0n`. */
    private async replayLeaves(toBlock: bigint): Promise<(bigint | undefined)[]> {
        // One topic-filtered eth_getLogs per event type, not one unfiltered call for all four:
        // a shared Semaphore deployment hosts other groups too, and their history isn't ours to
        // download on every mirror.
        const logsByEvent = await Promise.all(
            SEMAPHORE_GROUP_EVENTS.map((event) =>
                this.client.getLogs({
                    address: this.semaphoreAddress,
                    event,
                    args: { groupId: this.groupId },
                    fromBlock: this.fromBlock,
                    toBlock,
                    strict: true
                })
            )
        )
        const logs = logsByEvent.flat().sort((a, b) => {
            if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1
            return a.logIndex - b.logIndex
        })

        const byIndex = new Map<number, bigint>()
        let maxIndex = -1
        const set = (index: number, commitment: bigint) => {
            byIndex.set(index, commitment)
            if (index > maxIndex) maxIndex = index
        }

        for (const log of logs) {
            switch (log.eventName) {
                case "MemberAdded":
                    set(Number(log.args.index), log.args.identityCommitment)
                    break
                case "MembersAdded":
                    log.args.identityCommitments.forEach((commitment, offset) => {
                        set(Number(log.args.startIndex) + offset, commitment)
                    })
                    break
                case "MemberUpdated":
                    set(Number(log.args.index), log.args.newIdentityCommitment)
                    break
                case "MemberRemoved":
                    set(Number(log.args.index), 0n)
                    break
            }
        }

        return Array.from({ length: maxIndex + 1 }, (_, index) => byIndex.get(index))
    }
}

export interface SemaphoreRegistrationProverParams {
    /** The network member's own Semaphore identity. Its commitment must be a leaf of the mirrored group. */
    identity: Identity
    groupMirror: GroupMirror
    registry: RegistryLocation
}

/**
 * Chain-backed RegistrationProver: mirrors the approved-member group fresh for every call, then
 * generates the Semaphore proof authorising one IdentityRegistry write.
 */
export class SemaphoreRegistrationProver implements RegistrationProver {
    private readonly identity: Identity
    private readonly groupMirror: GroupMirror
    readonly registry: RegistryLocation

    constructor({ identity, groupMirror, registry }: SemaphoreRegistrationProverParams) {
        this.identity = identity
        this.groupMirror = groupMirror
        this.registry = registry
    }

    async prove(update: IdentityUpdate): Promise<NetworkMemberProof> {
        const group = await this.groupMirror.currentGroup()
        if (group.indexOf(this.identity.commitment) === -1) {
            throw new NetworkMemberClientError(
                "MEMBER_NOT_IN_GROUP",
                "identity is not a member of the approved-member group"
            )
        }
        return generateSemaphoreProof({ identity: this.identity, group, registry: this.registry, update })
    }
}

export interface SemaphoreRevocationProverParams {
    /** The network member's own Semaphore identity. Its commitment must be a leaf of the mirrored group. */
    identity: Identity
    groupMirror: GroupMirror
    registry: RegistryLocation
}

/**
 * Chain-backed RevocationProver: mirrors the approved-member group fresh for every call, then
 * generates the Semaphore proof authorising one write to the network's credential revocation
 * registry. The same group as registration's, reached through the same mirror: the registry
 * inherits `NetworkMemberGate`, so `SEMAPHORE()` and `NETWORK_MEMBER_GROUP_ID()` are public on it
 * too and the mirror only needs a different address.
 */
export class SemaphoreRevocationProver implements RevocationProver {
    private readonly identity: Identity
    private readonly groupMirror: GroupMirror
    readonly registry: RegistryLocation

    constructor({ identity, groupMirror, registry }: SemaphoreRevocationProverParams) {
        this.identity = identity
        this.groupMirror = groupMirror
        this.registry = registry
    }

    async prove(update: RevocationUpdate): Promise<NetworkMemberProof> {
        const group = await this.groupMirror.currentGroup()
        if (group.indexOf(this.identity.commitment) === -1) {
            throw new NetworkMemberClientError(
                "MEMBER_NOT_IN_GROUP",
                "identity is not a member of the approved-member group"
            )
        }
        return generateRevocationProof({ identity: this.identity, group, registry: this.registry, update })
    }
}

/**
 * Chain-backed RegistrationWriter over `IdentityRegistry.registerIdentity`. No receipt wait:
 * `AlreadyRegistered` surfaces at viem's gas estimate, and a returned txHash means submitted,
 * matching `RegistrationSubmitter`'s contract in `@coordination-network/user-client`.
 */
export class IdentityRegistryWriter implements RegistrationWriter {
    constructor(
        readonly registry: RegistryLocation,
        private readonly walletClient: Pick<WalletClient<Transport, Chain, Account>, "writeContract">
    ) {}

    async registerIdentity(
        networkId: Hex32,
        metaStealthAddress: Hex,
        proof: NetworkMemberProof
    ): Promise<RegistrationWrite> {
        try {
            const txHash = await this.walletClient.writeContract({
                address: this.registry.address,
                abi: IDENTITY_REGISTRY_ABI,
                functionName: "registerIdentity",
                args: [networkId, metaStealthAddress, proof]
            })
            return { txHash }
        } catch (error) {
            const errorName = revertErrorName(error)
            if (errorName !== undefined) throw new RegistryRevertError(errorName, error)
            throw error
        }
    }
}
