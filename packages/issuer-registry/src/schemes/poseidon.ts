import { poseidon2 } from "poseidon-lite/poseidon2"
import type { IssuerScheme } from "../types"

/** The BN254 scalar field order. */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

export function poseidonHash2(a: bigint, b: bigint): bigint {
    return poseidon2([a, b])
}

/** The default scheme, matching `IssuerRegistry` on chain. */
export const poseidonScheme: IssuerScheme = {
    hash: poseidonHash2,
    bound: SNARK_SCALAR_FIELD,
    boundDescription: "SNARK scalar field order"
}
