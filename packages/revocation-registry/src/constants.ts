/** Third input of the leaf hash, so callers can recompute a leaf. */
export const TAG_LEAF = 1n

/** `MEMBERSHIP`: the credential is revoked. `NON_MEMBERSHIP`: it is not. */
export const PROOF_TYPE = {
    MEMBERSHIP: 0,
    NON_MEMBERSHIP: 1
} as const

/** The sentinel `{ value: 0, nextValue: smallest }`, created by the first revocation. */
export const SENTINEL_INDEX = 0

/** Must match the snapshot version LeanIMT+ writes and enforces. */
export const SNAPSHOT_VERSION = 1
