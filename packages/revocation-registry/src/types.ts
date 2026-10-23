import type { LeanIMTPlusLeaf, LeanIMTPlusProof } from "@zk-kit/lean-imt-plus"

/** Anything that can be coerced to a field element with `BigInt()`. */
export type BigNumberish = bigint | number | string

/**
 * A revocation proof. Structurally a LeanIMT+ proof: a Merkle proof of a single
 * indexed leaf plus a `proofType` that says which extra check the verifier runs.
 *
 * - `proofType: 0` (membership): `leaf.value === value`, so the commitment is in
 *   the registry and the credential is revoked.
 * - `proofType: 1` (non-membership): `leaf` is the low leaf of `value`, so the
 *   commitment is absent and the credential is not revoked.
 *
 * `root` is the value the verifier must independently accept as one the
 * authoritative registry currently publishes. The proof proves nothing on its
 * own: its root is supplied by whoever built it.
 */
export type RevocationProof = LeanIMTPlusProof<bigint>

/** An indexed leaf of the revocation tree: a commitment and its successor. */
export type RevocationLeaf = LeanIMTPlusLeaf<bigint>
