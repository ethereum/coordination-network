import { poseidonScheme } from "./schemes/poseidon"
import type { BigNumberish, RevocationScheme } from "./types"
import { checkCommitment, checkFieldElement } from "./utils"

// A non-object `scheme`, such as the index `values.map(toCommitment)` passes, means the default, as in 0.2.1.
function schemeOrDefault(scheme: unknown): RevocationScheme {
    return typeof scheme === "object" && scheme !== null ? (scheme as RevocationScheme) : poseidonScheme
}

/** Coerces a value to a revocation commitment. `scheme` defaults to {@link poseidonScheme}. */
export function toCommitment(value: BigNumberish, scheme?: RevocationScheme): bigint {
    return checkCommitment(value, schemeOrDefault(scheme))
}

/** Coerces a value to the scheme's range, zero allowed. `scheme` defaults to {@link poseidonScheme}. */
export function toFieldElement(value: BigNumberish, scheme?: RevocationScheme): bigint {
    return checkFieldElement(value, schemeOrDefault(scheme))
}

export { PROOF_TYPE, SNAPSHOT_VERSION, TAG_LEAF } from "./constants"
export { RevocationRegistry } from "./revocation-registry"
export { SNARK_SCALAR_FIELD, poseidonScheme, revocationHashes } from "./schemes/poseidon"
export { SHA256_VALUE_BOUND, sha256Hash2, sha256Hash3, sha256Hashes, sha256Scheme } from "./schemes/sha256"
export type { BigNumberish, RevocationLeaf, RevocationProof, RevocationScheme } from "./types"
