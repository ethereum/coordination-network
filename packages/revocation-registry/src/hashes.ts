import type { LeanIMTPlusHashFunctions } from "@zk-kit/lean-imt-plus"
import { poseidon2 } from "poseidon-lite/poseidon2"
import { poseidon3 } from "poseidon-lite/poseidon3"

/**
 * The hash pair every revocation registry uses, in every language.
 *
 * - `leaf` is a 3-input Poseidon over `(value, nextValue, TAG_LEAF)`. It matches
 *   `PoseidonT4` in the LeanIMT+ Solidity library and `poseidon::bn254::hash_3`
 *   in a BN254 Poseidon circuit.
 * - `internal` is a 2-input Poseidon for inner nodes. It matches `PoseidonT3`
 *   and `poseidon::bn254::hash_2`.
 *
 * The differing arity is what domain-separates a leaf commitment from an
 * internal-node hash, which closes the second-preimage attack in which an
 * attacker repackages an internal node as a leaf. All three implementations
 * must agree on this pair or their roots will not match.
 */
export const revocationHashes: LeanIMTPlusHashFunctions<bigint> = {
    leaf: (a, b, c) => poseidon3([a, b, c]),
    internal: (a, b) => poseidon2([a, b])
}
