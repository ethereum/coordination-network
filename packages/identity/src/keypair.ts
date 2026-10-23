import { secp256k1 } from "@noble/curves/secp256k1"
import type { Secp256k1Keypair } from "./types"
import { bytesToHex } from "./bytes"
import { DerivationFailureError } from "./errors"

const N = secp256k1.CURVE.n

/**
 * Tests whether `scalar` is a valid secp256k1 private key: exactly 32 bytes
 * encoding an integer in `[1, n)`.
 */
export function isValidScalar(scalar: Uint8Array): boolean {
    if (scalar.length !== 32) {
        return false
    }

    const value = BigInt(bytesToHex(scalar))

    return value >= 1n && value < N
}

/**
 * Expands a 32-byte private scalar into a full {@link Secp256k1Keypair}, with
 * all fields as lowercase `0x` hex.
 *
 * @throws {DerivationFailureError} if `scalar` is not in `[1, n)`
 */
export function scalarToKeypair(scalar: Uint8Array): Secp256k1Keypair {
    if (!isValidScalar(scalar)) {
        throw new DerivationFailureError("Derived scalar is not a valid secp256k1 private key in [1, n)")
    }

    return {
        privateKey: bytesToHex(scalar),
        publicKey: bytesToHex(secp256k1.getPublicKey(scalar, true)),
        uncompressedPublicKey: bytesToHex(secp256k1.getPublicKey(scalar, false))
    }
}
