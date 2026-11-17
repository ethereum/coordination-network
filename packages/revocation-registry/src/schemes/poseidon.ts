import type { LeanIMTPlusHashFunctions } from "@zk-kit/lean-imt-plus"
import { poseidon2 } from "poseidon-lite/poseidon2"
import { poseidon3 } from "poseidon-lite/poseidon3"
import type { RevocationScheme } from "../types"

/** The BN254 scalar field order. */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

/**
 * Poseidon over BN254: `leaf` is 3-input (`PoseidonT4`), `internal` is 2-input
 * (`PoseidonT3`). The arity difference domain-separates leaves from nodes.
 */
export const revocationHashes: LeanIMTPlusHashFunctions<bigint> = {
    leaf: (a, b, c) => poseidon3([a, b, c]),
    internal: (a, b) => poseidon2([a, b])
}

/** The default scheme, matching `Revocation` on chain and the Noir credential circuit. */
export const poseidonScheme: RevocationScheme = {
    hashes: revocationHashes,
    bound: SNARK_SCALAR_FIELD,
    boundDescription: "SNARK scalar field order"
}
