import type { Hex32, SerializedZkCredential } from "@coordination-network/credential"
import type { IssuerMembershipWitness } from "@coordination-network/issuer-set"
import type { Address, Hex, buildAnnouncement } from "@coordination-network/identity"
import type {
    IdentityUpdate,
    NetworkMemberProof,
    RegistryLocation,
    RevocationUpdate
} from "@coordination-network/network-member-proof"
import type { Group } from "@semaphore-protocol/group"

export type { ApprovalResolver, CredentialSigner } from "@coordination-network/credential"
export type { ContractLeafReader, IssuerMembershipWitness } from "@coordination-network/issuer-set"
export type { ChainDomain, RegistrationRequest } from "@coordination-network/user-client"

/** issueVC's result: the signed claim-tree credential plus a fresh Merkle path into the approved-issuer set. */
export interface IssuedCredential {
    credential: SerializedZkCredential
    issuerSetRoot: bigint
    issuerMembershipWitness: IssuerMembershipWitness
}

/**
 * Reads `IdentityRegistry.identity(networkId)`. Empty bytes on chain (unregistered) resolves to
 * null. The method name matches the UserClient's registry-reader port so one adapter serves both.
 */
export interface IdentityReader {
    /** The IdentityRegistry deployment this reader targets, when the reader knows one. submitRegistration checks it against `domain`. */
    readonly registryAddress?: Address
    getIdentity(networkId: Hex32): Promise<Hex | null>
}

/** `buildAnnouncement`'s return shape, derived rather than restated so it can't drift. */
export type Announcement = ReturnType<typeof buildAnnouncement>

/** Submits a built ERC-5564 announcement on chain. */
export interface AnnouncementSubmitter {
    announce(announcement: Announcement): Promise<Hex>
}

/**
 * deliverToStealth's result. txHash is the hash of the submitted announce transaction, not proof
 * of inclusion: confirm it before treating the delivery as done.
 */
export interface DeliveredToStealth {
    stealthAddress: Address
    announcement: Announcement
    txHash: Hex
}

/** The approved-member group, rebuilt fresh on every call so a proof always proves against a live root. */
export interface GroupMirror {
    currentGroup(): Promise<Group>
}

/** Produces the membership proof authorising one IdentityRegistry write. */
export interface RegistrationProver {
    /** The IdentityRegistry deployment this proof is bound to. submitRegistration checks it against `domain`. */
    readonly registry: RegistryLocation
    prove(update: IdentityUpdate): Promise<NetworkMemberProof>
}

/** Produces the membership proof authorising one CredentialRevocationRegistry write. */
export interface RevocationProver {
    /** The CredentialRevocationRegistry deployment this proof is bound to. */
    readonly registry: RegistryLocation
    prove(update: RevocationUpdate): Promise<NetworkMemberProof>
}

/**
 * Facts about a sponsored registerIdentity call: what the disposable sender and the paymaster's
 * deposit looked like before and after, so a caller can show what the paymaster actually paid.
 */
export interface Sponsorship {
    sender: Address
    senderBalanceBefore: bigint
    senderBalanceAfter: bigint
    userOpHash: Hex
    bundleTxHash: Hex
    actualGasCost: bigint
    paymaster: Address
    paymasterDepositBefore: bigint
    paymasterDepositAfter: bigint
}

/**
 * registerIdentity's result. txHash is the hash of the write (or, when sponsored, the bundle)
 * transaction, not proof of inclusion: confirm it before treating the registration as done.
 */
export interface RegistrationWrite {
    txHash: Hex
    sponsorship?: Sponsorship
}

/** Submits a network-member-authorised write to `IdentityRegistry`. */
export interface RegistrationWriter {
    /** The IdentityRegistry deployment this writer targets. submitRegistration checks it against `domain`. */
    readonly registry: RegistryLocation
    /** An `AlreadyRegistered` revert must surface as `RegistryRevertError`: submitRegistration's
     *  lost-race handling keys on that one specifically. Any other revert may surface as any error. */
    registerIdentity(networkId: Hex32, metaStealthAddress: Hex, proof: NetworkMemberProof): Promise<RegistrationWrite>
}

/**
 * revoke's result. txHash is the hash of the write (or, when sponsored, the bundle) transaction,
 * not proof of inclusion: confirm it before treating the revocation as done.
 */
export interface RevocationWrite {
    txHash: Hex
    sponsorship?: Sponsorship
}

/** Submits a network-member-authorised write to `CredentialRevocationRegistry`. */
export interface RevocationRegistryWriter {
    /** The CredentialRevocationRegistry deployment this writer targets. */
    readonly registry: RegistryLocation
    /** A revert must surface as `RevocationRevertError`: a caller has to tell a stale
     *  `lowLeafIndex`, which it retries, from an already-revoked commitment, which it does not. */
    revoke(commitment: bigint, lowLeafIndex: bigint, proof: NetworkMemberProof): Promise<RevocationWrite>
}

/**
 * submitRegistration's result. txHash on `submitted` is the hash of the write transaction, not
 * proof of inclusion: confirm it before treating the registration as done.
 */
export type SubmitRegistrationResult =
    | { status: "submitted"; networkId: Hex32; metaStealthAddress: Hex; txHash: Hex; sponsorship?: Sponsorship }
    | { status: "alreadyRegistered"; networkId: Hex32; metaStealthAddress: Hex; matchesRequest: boolean }
