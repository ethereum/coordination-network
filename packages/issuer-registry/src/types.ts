import type { LeanIMTHashFunction, LeanIMTMerkleProof } from "@zk-kit/lean-imt"

/** Anything `BigInt()` accepts. */
export type BigNumberish = bigint | number | string

/** A membership proof. `root` is set by the prover, so verifiers must check it independently. */
export type IssuerProof = LeanIMTMerkleProof<bigint>

/** The node hash and value range. Roots only match a contract or circuit using the same scheme. */
export interface IssuerScheme {
    readonly hash: LeanIMTHashFunction<bigint>
    /** Exclusive upper bound on every commitment, such as the field order. */
    readonly bound: bigint
    readonly boundDescription?: string
}
