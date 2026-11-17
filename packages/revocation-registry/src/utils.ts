import type { BigNumberish, RevocationScheme } from "./types"

/**
 * Coerces a value to an element of the scheme's range. Zero is allowed (sentinel
 * and tombstones). Out-of-range values could alias another value in the hash
 * and let one revocation cover an unrelated credential.
 */
export function checkFieldElement(value: BigNumberish, scheme: RevocationScheme): bigint {
    // Otherwise `element >= undefined` is false and the range check passes, e.g. for `values.map(toCommitment)`.
    if (typeof scheme?.bound !== "bigint") {
        throw new Error("RevocationRegistry: the scheme must have a bigint bound")
    }

    const element = BigInt(value)

    if (element < 0n) {
        throw new Error("RevocationRegistry: a field element must not be negative")
    }

    if (element >= scheme.bound) {
        throw new Error(
            `RevocationRegistry: a field element must be less than the ${scheme.boundDescription ?? "scheme's bound"}`
        )
    }

    return element
}

/** Coerces a value to a revocation commitment: non-zero and in the scheme's range. */
export function checkCommitment(value: BigNumberish, scheme: RevocationScheme): bigint {
    const commitment = BigInt(value)

    if (commitment <= 0n) {
        throw new Error("RevocationRegistry: a commitment must be greater than zero")
    }

    return checkFieldElement(commitment, scheme)
}
