import type { LeanIMTPlusHashFunctions, LeanIMTPlusLeaf, LeanIMTPlusProof } from "@zk-kit/lean-imt-plus"

/** Anything `BigInt()` accepts. */
export type BigNumberish = bigint | number | string

/**
 * `proofType: 0` proves the commitment is revoked, `proofType: 1` that it is
 * not. `root` is set by the prover, so the verifier must check it independently.
 */
export type RevocationProof = LeanIMTPlusProof<bigint>

/** A commitment and its successor in sorted order. */
export type RevocationLeaf = LeanIMTPlusLeaf<bigint>

/**
 * The hash functions and field a registry works over. Roots only match a
 * contract or circuit using the same scheme.
 *
 * Both hashes must accept every value below {@link bound}, the internal hash
 * must accept every hash output, and the leaf hash `(value, nextValue, TAG_LEAF)`
 * must be domain-separated from the internal hash `(left, right)`, or a node
 * could pass as a leaf.
 */
export interface RevocationScheme {
    readonly hashes: LeanIMTPlusHashFunctions<bigint>
    /**
     * Exclusive upper bound on every commitment and leaf value, such as the field
     * order or `2^n` for an n-bit hash. Hash outputs are not checked against it.
     */
    readonly bound: bigint
    /** Names {@link bound} in error messages. */
    readonly boundDescription?: string
}
