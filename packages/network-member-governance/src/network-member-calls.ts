import type { MetaTransactionData, SafeTransactionData } from "@safe-global/types-kit"
import {
    concat,
    decodeEventLog,
    encodeFunctionData,
    getAddress,
    hexToBigInt,
    isAddressEqual,
    keccak256,
    pad,
    size,
    slice,
    toHex,
    type Address,
    type Hex
} from "viem"

import { buildSafeTransactionData } from "./safe-transaction"
import type { SafeContext } from "./types"

/**
 * The `NetworkMemberGovernance` surface: the governance operations, each one call.
 *
 * There is no threshold argument anywhere here. The contract computes it from the Safe's live owner
 * count, and removal reads the member's commitment and signer from the registry, so no caller can
 * carry a wrong threshold, point at another member's leaf, or take arbitrary calldata.
 *
 * `expectedMemberCount` is not a policy input either. It pins the member set a transaction was built
 * against, so a transaction goes stale the moment that set changes. It has to exist because a
 * voluntary exit changes the owner count and the threshold without advancing the Safe's nonce, which is
 * what would otherwise invalidate transactions in flight.
 */
export const NETWORK_MEMBER_GOVERNANCE_ABI = [
    {
        type: "function",
        name: "admitMember",
        stateMutability: "nonpayable",
        inputs: [
            { name: "accountKeyX", type: "uint256" },
            { name: "accountKeyY", type: "uint256" },
            { name: "semaphoreCommitment", type: "uint256" },
            { name: "governanceSigner", type: "address" },
            { name: "expectedMemberCount", type: "uint256" }
        ],
        outputs: []
    },
    {
        type: "function",
        name: "removeMember",
        stateMutability: "nonpayable",
        inputs: [
            { name: "memberNetworkId", type: "bytes32" },
            { name: "merkleProofSiblings", type: "uint256[]" },
            { name: "expectedMemberCount", type: "uint256" }
        ],
        outputs: []
    },
    {
        type: "function",
        name: "exitNetwork",
        stateMutability: "nonpayable",
        inputs: [
            { name: "memberNetworkId", type: "bytes32" },
            { name: "merkleProofSiblings", type: "uint256[]" }
        ],
        outputs: []
    },
    {
        type: "function",
        name: "governanceThreshold",
        stateMutability: "pure",
        inputs: [{ name: "memberCount", type: "uint256" }],
        outputs: [{ name: "", type: "uint256" }]
    },
    {
        type: "function",
        name: "thresholdAfterAdmission",
        stateMutability: "view",
        inputs: [],
        outputs: [{ name: "", type: "uint256" }]
    }
] as const

/** The event a candidate's join request emits, for watching with `getLogs`. */
export const NETWORK_MEMBER_JOIN_REQUESTED_EVENT = {
    type: "event",
    name: "NetworkMemberJoinRequested",
    inputs: [
        { name: "memberNetworkId", type: "bytes32", indexed: true },
        { name: "accountKeyX", type: "uint256", indexed: false },
        { name: "accountKeyY", type: "uint256", indexed: false },
        { name: "semaphoreCommitment", type: "uint256", indexed: false },
        { name: "governanceSigner", type: "address", indexed: false },
        { name: "metadataURI", type: "string", indexed: false }
    ]
} as const

/** The `NetworkMemberRegistry` surface a member server needs directly. */
export const NETWORK_MEMBER_REGISTRY_ABI = [
    {
        type: "function",
        name: "requestToJoin",
        stateMutability: "nonpayable",
        inputs: [
            { name: "accountKeyX", type: "uint256" },
            { name: "accountKeyY", type: "uint256" },
            { name: "semaphoreCommitment", type: "uint256" },
            { name: "governanceSigner", type: "address" },
            { name: "metadataURI", type: "string" }
        ],
        outputs: []
    },
    NETWORK_MEMBER_JOIN_REQUESTED_EVENT
] as const

/** Where the governance operations live. */
export interface GovernanceContracts {
    /** The `NetworkMemberGovernance` orchestrator, enabled as a module on the Safe. */
    governance: Address
    /** The `NetworkMemberRegistry`, for reading records and for a candidate's own join request. */
    registry: Address
}

/**
 * What a candidate published in its `NetworkMemberJoinRequested` event, which is every argument its
 * admission will carry.
 *
 * Approvers build this from the event rather than from anything another party sends them, so an
 * admission is a function of the candidate's own announcement.
 */
export interface NetworkMemberJoinRequest {
    /**
     * The candidate's networkId, `keccak256(X || Y)` of its account key. Filled from the event topic
     * when decoding, and ignored by the encoders, which pass the key.
     */
    memberNetworkId: Hex
    /** The X coordinate of the candidate's account key, a secp256k1 public key. */
    accountKeyX: bigint
    /** The Y coordinate of the candidate's account key. */
    accountKeyY: bigint
    /** The Semaphore identity commitment it wants in the approved-member group. */
    semaphoreCommitment: bigint
    /** The address it wants added to the governance Safe, so it can vote on later candidates. */
    governanceSigner: Address
    /** Where the vetting material lives, or an empty string. */
    metadataURI?: string
}

/** What removing a member needs. */
export interface NetworkMemberRemoval {
    /** The member's networkId. Its commitment and signer are read on chain. */
    memberNetworkId: Hex
    /**
     * The membership proof for its group leaf, computed off chain against the group state this
     * transaction will execute in. If another group write lands first, recompute it and approve the
     * rebuilt transaction.
     */
    merkleProofSiblings: bigint[]
}

/** The shape of a log this package can read: enough of viem's `Log` to decode it. */
export interface JoinRequestLog {
    /** The contract that emitted it. Checked against the registry when both are given. */
    address?: Address
    /** The log's topics, the first being the event signature. */
    topics: readonly Hex[]
    /** The log's non-indexed data. */
    data: Hex
}

/**
 * Turns a `NetworkMemberJoinRequested` log into the request it announced.
 *
 * This is the only honest source of a {NetworkMemberJoinRequest}: an approver reads the candidate's own
 * event from a node it trusts and decodes it here, so the transaction it approves is a function of what
 * the chain reported. Building the object by hand from something another party sent gives up that
 * property, and with it the meaning of the approval.
 *
 * It stays free of any RPC dependency: fetching the log is the caller's job, with `getLogs` against its
 * own node. What this removes is the field mapping, and the chance of a silent mismatch in it.
 *
 * @param log The log, as viem returns it from `getLogs`.
 * @param registry The registry the log must have come from. Checked when the log carries an address.
 * @returns The request the candidate published.
 */
export function decodeJoinRequestLog(log: JoinRequestLog, registry?: Address): NetworkMemberJoinRequest {
    if (log.address && registry && !isAddressEqual(log.address, getAddress(registry))) {
        throw new Error(`Log came from ${log.address}, not from the registry at ${getAddress(registry)}`)
    }

    const { args } = decodeEventLog({
        abi: NETWORK_MEMBER_REGISTRY_ABI,
        eventName: "NetworkMemberJoinRequested",
        data: log.data,
        topics: log.topics as [signature: Hex, ...args: Hex[]]
    })

    const keyHash = keccak256(concat([pad(toHex(args.accountKeyX)), pad(toHex(args.accountKeyY))]))
    if (args.memberNetworkId !== keyHash) {
        throw new Error(`Log's memberNetworkId ${args.memberNetworkId} is not the hash of the account key it carries`)
    }

    return {
        memberNetworkId: args.memberNetworkId,
        accountKeyX: args.accountKeyX,
        accountKeyY: args.accountKeyY,
        semaphoreCommitment: args.semaphoreCommitment,
        governanceSigner: getAddress(args.governanceSigner),
        metadataURI: args.metadataURI
    }
}

/**
 * The networkId and key coordinates of a member's account key, the secp256k1 key whose address is its
 * auth address.
 *
 * @param uncompressedPublicKey The public key: 65 bytes with the `0x04` prefix, or the raw 64 bytes of X || Y.
 * @returns The coordinates, and `keccak256(X || Y)`, which is the id the registry derives from them.
 */
export function memberAccountKey(uncompressedPublicKey: Hex): {
    memberNetworkId: Hex
    accountKeyX: bigint
    accountKeyY: bigint
} {
    // `size` rounds an odd digit count up, so the length is checked on the digits themselves.
    if (!/^0x(04)?[0-9a-fA-F]{128}$/.test(uncompressedPublicKey)) {
        throw new Error(
            `Expected a 64-byte X || Y or a 65-byte 0x04-prefixed public key of hex digits, got ${uncompressedPublicKey.length} characters`
        )
    }

    const coordinates = slice(uncompressedPublicKey, size(uncompressedPublicKey) - 64)

    return {
        memberNetworkId: keccak256(coordinates),
        accountKeyX: hexToBigInt(slice(coordinates, 0, 32)),
        accountKeyY: hexToBigInt(slice(coordinates, 32))
    }
}

/**
 * The single call that admits a network member: its record, its group leaf, and its seat at the Safe.
 *
 * @param admission The vetted join request being approved.
 * @param memberCount The Safe's live owner count, from `getOwners().length`. Pinned into the call so the
 * transaction goes stale if the member set changes before it executes.
 * @returns Calldata for the orchestrator.
 */
export function encodeAdmitMember(admission: NetworkMemberJoinRequest, memberCount: number): Hex {
    return encodeFunctionData({
        abi: NETWORK_MEMBER_GOVERNANCE_ABI,
        functionName: "admitMember",
        args: [
            admission.accountKeyX,
            admission.accountKeyY,
            admission.semaphoreCommitment,
            getAddress(admission.governanceSigner),
            BigInt(memberCount)
        ]
    })
}

/**
 * The single call that removes a network member from all three places.
 *
 * @param removal The member to remove, and its membership proof.
 * @param memberCount The Safe's live owner count, pinned for the reason given on {encodeAdmitMember}.
 * @returns Calldata for the orchestrator.
 */
export function encodeRemoveMember(removal: NetworkMemberRemoval, memberCount: number): Hex {
    return encodeFunctionData({
        abi: NETWORK_MEMBER_GOVERNANCE_ABI,
        functionName: "removeMember",
        args: [removal.memberNetworkId, removal.merkleProofSiblings, BigInt(memberCount)]
    })
}

/** The one call an admission is, as a Safe meta-transaction. */
export function admissionCall(
    contracts: GovernanceContracts,
    admission: NetworkMemberJoinRequest,
    memberCount: number
): MetaTransactionData {
    return { to: getAddress(contracts.governance), value: "0", data: encodeAdmitMember(admission, memberCount) }
}

/** The one call a removal is, as a Safe meta-transaction. */
export function removalCall(
    contracts: GovernanceContracts,
    removal: NetworkMemberRemoval,
    memberCount: number
): MetaTransactionData {
    return { to: getAddress(contracts.governance), value: "0", data: encodeRemoveMember(removal, memberCount) }
}

/**
 * Builds the Safe transaction that admits a network member.
 *
 * One plain call to the orchestrator, so there is no MultiSend batch to decode and no threshold in the
 * calldata to check. The result is a pure function of the on-chain request and the nonce, which is what
 * makes building safe to do in parallel: two approvers who build from the same chain state produce
 * byte-identical transactions and therefore the same `safeTxHash`, so their approvals accumulate
 * against one hash instead of competing.
 *
 * @param contracts The governance contracts.
 * @param admission The vetted join request being approved.
 * @param context The Safe and chain the transaction is for.
 * @param nonce The Safe's current `nonce()`.
 * @param memberCount The Safe's live owner count, from `getOwners().length`.
 * @returns The transaction data to sign.
 */
export function buildAdmissionTransaction(
    contracts: GovernanceContracts,
    admission: NetworkMemberJoinRequest,
    context: SafeContext,
    nonce: number,
    memberCount: number
): SafeTransactionData {
    return buildSafeTransactionData([admissionCall(contracts, admission, memberCount)], context, nonce)
}

/**
 * Builds the Safe transaction that removes a network member.
 *
 * @param contracts The governance contracts.
 * @param removal The member to remove, and its membership proof.
 * @param context The Safe and chain the transaction is for.
 * @param nonce The Safe's current `nonce()`.
 * @param memberCount The Safe's live owner count, from `getOwners().length`.
 * @returns The transaction data to sign.
 */
export function buildRemovalTransaction(
    contracts: GovernanceContracts,
    removal: NetworkMemberRemoval,
    context: SafeContext,
    nonce: number,
    memberCount: number
): SafeTransactionData {
    return buildSafeTransactionData([removalCall(contracts, removal, memberCount)], context, nonce)
}

/**
 * Calldata for a member leaving the network of its own accord: its record, its group leaf and its seat
 * at the Safe, in one call.
 *
 * Not a Safe transaction. The member's own governance signer sends this directly to the orchestrator,
 * because departure does not need the consent of the members being left, so there is no transaction
 * for anyone else to approve. It is also how a member that is winding down avoids leaving a seat behind
 * that nobody can sign for, which would still count toward everyone else's threshold.
 *
 * Rejoining means a new request and a new place in the group, and every credential the member issued
 * stops verifying once its record is gone.
 *
 * @param memberNetworkId The member leaving. The caller must be its governance signer.
 * @param merkleProofSiblings The membership proof for its group leaf, computed off chain against the
 * group state this transaction will execute in.
 * @returns Calldata to send to the orchestrator.
 */
export function encodeExitNetwork(memberNetworkId: Hex, merkleProofSiblings: bigint[]): Hex {
    return encodeFunctionData({
        abi: NETWORK_MEMBER_GOVERNANCE_ABI,
        functionName: "exitNetwork",
        args: [memberNetworkId, merkleProofSiblings]
    })
}

/**
 * Calldata for a candidate's own join request, the one permissionless call in this flow. It must be
 * sent from the address of the account key, and `governanceSigner` must be a different key.
 *
 * @param request The request to announce.
 * @returns Calldata for the registry.
 */
export function encodeRequestToJoin(request: NetworkMemberJoinRequest): Hex {
    return encodeFunctionData({
        abi: NETWORK_MEMBER_REGISTRY_ABI,
        functionName: "requestToJoin",
        args: [
            request.accountKeyX,
            request.accountKeyY,
            request.semaphoreCommitment,
            getAddress(request.governanceSigner),
            request.metadataURI ?? ""
        ]
    })
}
