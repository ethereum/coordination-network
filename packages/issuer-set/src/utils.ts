import { inCurve, mulPointEscalar, subOrder } from "@zk-kit/baby-jubjub"
import { COFACTOR, SNARK_SCALAR_FIELD } from "./constants"
import type { BigNumberish, IssuerPublicKey } from "./types"

/**
 * Coerces a value to a BN254 field element, rejecting anything outside the
 * field.
 *
 * Every leaf and every hash the set produces must be a field element: outside
 * that range two distinct values reduce to the same element, so one key's
 * membership proof would open against another's leaf.
 *
 * Zero is accepted, because a tombstoned or never-written slot holds it.
 *
 * @param value The value, as a bigint, number or decimal string.
 * @returns The value as a bigint.
 */
export function toFieldElement(value: BigNumberish): bigint {
    const element = BigInt(value)

    if (element < 0n) {
        throw new Error("ApprovedIssuerSet: a field element must not be negative")
    }

    if (element >= SNARK_SCALAR_FIELD) {
        throw new Error("ApprovedIssuerSet: a field element must be less than the SNARK scalar field order")
    }

    return element
}

/**
 * Whether a point is a non-identity element of Baby Jubjub's prime-order
 * subgroup: canonical coordinates, on the curve, and `subOrder` times it is the
 * identity. Coordinates are checked because zk-kit reduces them mod the field.
 *
 * @param point The point as `[x, y]`.
 */
export function inPrimeOrderSubgroup(point: [bigint, bigint]): boolean {
    if (point.some((c) => c < 0n || c >= SNARK_SCALAR_FIELD)) return false
    if (!inCurve(point) || (point[0] === 0n && point[1] === 1n)) return false

    const [x, y] = mulPointEscalar(point, subOrder)

    return x === 0n && y === 1n
}

/**
 * Coerces a pair to a Baby Jubjub public key of prime order, rejecting a point
 * that is not on the curve, that lies in the small-order subgroup, or that
 * mixes a prime-order part with a torsion part.
 *
 * The set would happily commit to any two field elements, so without the curve
 * check a caller could publish a commitment to a point that does not exist.
 *
 * The order check matters more. Under a low-order public key `A` the term `h·A`
 * in EdDSA verification takes at most eight values whatever the message, so
 * anyone can solve `S·B = R + h·A` for a signature over a claim tree they chose;
 * at the identity it is immediate. Publishing such a key would hand every
 * stranger the member's issuing power. `ApprovedIssuerSet.sol` rejects the same
 * low-order points.
 *
 * Under the circuit's cofactored EdDSA only the holder of `A`'s secret can sign
 * under a mixed-order key `A + T`, so it would only let one secret occupy several
 * leaves. The contract does not reject it; this function is stricter.
 *
 * @param publicKey The signing key as `[x, y]`.
 * @returns The key with both coordinates as bigints.
 */
export function toPublicKey(publicKey: IssuerPublicKey): [bigint, bigint] {
    const point: [bigint, bigint] = [toFieldElement(publicKey[0]), toFieldElement(publicKey[1])]

    if (!inCurve(point)) {
        throw new Error("ApprovedIssuerSet: the public key is not a point on Baby Jubjub")
    }

    // A point has low order exactly when eight times it is the identity, the curve's cofactor being
    // eight. That is the same set of eight points the contract rejects by x coordinate.
    const [x, y] = mulPointEscalar(point, COFACTOR)

    if (x === 0n && y === 1n) {
        throw new Error("ApprovedIssuerSet: the public key has low order")
    }

    if (!inPrimeOrderSubgroup(point)) {
        throw new Error("ApprovedIssuerSet: the public key is not in the prime-order subgroup")
    }

    return point
}
