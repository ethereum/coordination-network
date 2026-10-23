/**
 * The BN254 (alt_bn128) scalar field order. Every commitment stored in a
 * revocation registry, and every hash the tree produces, is an element of this
 * field. It matches `SNARK_SCALAR_FIELD` in the LeanIMT+ Solidity library and
 * the field a BN254 zero-knowledge circuit works over.
 */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

/**
 * Domain-separation tag mixed into every leaf commitment as the third input of
 * the 3-input leaf hash. Kept here so callers can reproduce a leaf commitment
 * without depending on LeanIMT+ internals.
 */
export const TAG_LEAF = 1n

/**
 * Proof discriminator. `MEMBERSHIP` proves the commitment is in the registry
 * (the credential is revoked); `NON_MEMBERSHIP` proves it is absent (the
 * credential is not revoked). A holder proving a valid credential always
 * produces a `NON_MEMBERSHIP` proof.
 */
export const PROOF_TYPE = {
    MEMBERSHIP: 0,
    NON_MEMBERSHIP: 1
} as const

/**
 * Physical index of the sentinel leaf, which the first revocation creates. The
 * sentinel holds `{ value: 0, nextValue: firstRealCommitment }` and is the
 * predecessor of the smallest commitment in the registry.
 */
export const SENTINEL_INDEX = 0

/**
 * Version tag of the snapshot format produced by `export` and accepted by
 * `import`. It must match the version the underlying LeanIMT+ writes, which
 * enforces it on import.
 */
export const SNAPSHOT_VERSION = 1
