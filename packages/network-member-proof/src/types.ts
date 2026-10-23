/** Which mutation of the IdentityRegistry a proof authorises. Matches the on-chain enum. */
export enum UpdateAction {
    Register = 0,
    Update = 1,
    Remove = 2
}

/** The update a member is authorising, exactly as it will be submitted. */
export type IdentityUpdate = {
    action: UpdateAction
    /** The networkId being written. */
    networkId: `0x${string}`
    /** The 66-byte ERC-6538 meta-stealth address being written. Omitted for a removal. */
    metaStealthAddress?: `0x${string}`
}

/** Where the registry is deployed. The message binds an update to this pair. */
export type RegistryLocation = {
    chainId: bigint
    address: `0x${string}`
}

/**
 * A membership proof in the shape the registry's NetworkMemberProof struct expects: Semaphore's proof
 * without its message. The registry derives the message from the call's own arguments, so it is the
 * one public signal a caller never supplies.
 */
export type NetworkMemberProof = {
    merkleTreeDepth: bigint
    merkleTreeRoot: bigint
    nullifier: bigint
    scope: bigint
    points: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint]
}

/** Which mutation of the CredentialRevocationRegistry a proof authorises. Matches the on-chain enum. */
export enum RevocationAction {
    Revoke = 0,
    RevokeMany = 1,
    Unrevoke = 2,
    UpdateCommitment = 3
}

/**
 * The revocation the member is authorising, exactly as it will be submitted. Predecessor indices are
 * absent because the message does not bind them, so one proof survives a recomputed index.
 */
export type RevocationUpdate =
    | { action: RevocationAction.Revoke; revocationCommitment: bigint }
    | { action: RevocationAction.Unrevoke; revocationCommitment: bigint }
    | { action: RevocationAction.RevokeMany; revocationCommitments: readonly bigint[] }
    | {
          action: RevocationAction.UpdateCommitment
          oldRevocationCommitment: bigint
          newRevocationCommitment: bigint
      }
