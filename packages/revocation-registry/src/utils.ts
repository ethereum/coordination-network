import { SNARK_SCALAR_FIELD } from "./constants"
import type { BigNumberish } from "./types"

/**
 * Coerces a value to a BN254 field element, rejecting anything outside the
 * field.
 *
 * Every leaf field and every hash the registry produces must be a field element:
 * outside that range two distinct values reduce to the same element, which would
 * let one revocation silently cover an unrelated credential and would break the
 * sorted ordering a non-membership proof relies on.
 *
 * Zero is accepted, because the sentinel and tombstone leaf slots hold it. Use
 * {@link toCommitment} for anything that must be a real commitment.
 *
 * @param value The value, as a bigint, number or decimal string.
 * @returns The value as a bigint.
 */
export function toFieldElement(value: BigNumberish): bigint {
    const element = BigInt(value)

    if (element < 0n) {
        throw new Error("RevocationRegistry: a field element must not be negative")
    }

    if (element >= SNARK_SCALAR_FIELD) {
        throw new Error("RevocationRegistry: a field element must be less than the SNARK scalar field order")
    }

    return element
}

/**
 * Coerces a value to a revocation commitment, rejecting anything the registry
 * cannot hold as one.
 *
 * A commitment must be a field element, for the reason given on
 * {@link toFieldElement}, and must additionally be non-zero, because zero is
 * reserved for the sentinel leaf and for tombstones.
 *
 * These are the rules of the structure itself, so every implementation of a
 * registry enforces them.
 *
 * @param value The commitment, as a bigint, number or decimal string.
 * @returns The commitment as a bigint.
 */
export function toCommitment(value: BigNumberish): bigint {
    const commitment = BigInt(value)

    if (commitment <= 0n) {
        throw new Error("RevocationRegistry: a commitment must be greater than zero")
    }

    return toFieldElement(commitment)
}
