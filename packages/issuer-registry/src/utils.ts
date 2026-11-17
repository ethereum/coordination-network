import type { BigNumberish, IssuerScheme } from "./types"

/** Coerces a value to the scheme's range, zero allowed. */
export function checkFieldElement(value: BigNumberish, scheme: IssuerScheme): bigint {
    // Otherwise `element >= undefined` passes, e.g. for `values.map(toCommitment)`.
    if (typeof scheme?.bound !== "bigint") {
        throw new Error("IssuerRegistry: the scheme must have a bigint bound")
    }

    const element = BigInt(value)

    if (element < 0n) {
        throw new Error("IssuerRegistry: a field element must not be negative")
    }

    if (element >= scheme.bound) {
        throw new Error(
            `IssuerRegistry: a field element must be less than the ${scheme.boundDescription ?? "scheme's bound"}`
        )
    }

    return element
}

/** Coerces a value to a non-zero commitment in the scheme's range. */
export function checkCommitment(value: BigNumberish, scheme: IssuerScheme): bigint {
    const commitment = BigInt(value)

    if (commitment <= 0n) {
        throw new Error("IssuerRegistry: a commitment must be greater than zero")
    }

    return checkFieldElement(commitment, scheme)
}
