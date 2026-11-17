import { poseidonScheme } from "./schemes/poseidon"
import type { BigNumberish, IssuerScheme } from "./types"
import { checkCommitment, checkFieldElement } from "./utils"

/** `scheme` defaults to {@link poseidonScheme}. */
export function toCommitment(value: BigNumberish, scheme: IssuerScheme = poseidonScheme): bigint {
    return checkCommitment(value, scheme)
}

/** Zero allowed. `scheme` defaults to {@link poseidonScheme}. */
export function toFieldElement(value: BigNumberish, scheme: IssuerScheme = poseidonScheme): bigint {
    return checkFieldElement(value, scheme)
}

export { IssuerRegistry } from "./issuer-registry"
export { SNARK_SCALAR_FIELD, poseidonHash2, poseidonScheme } from "./schemes/poseidon"
export { SHA256_VALUE_BOUND, sha256Hash2, sha256Scheme } from "./schemes/sha256"
export type { BigNumberish, IssuerProof, IssuerScheme } from "./types"
