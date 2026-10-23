import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToNumberBE } from "@noble/curves/utils"
import { Hex } from "../types"

/**
 * Generates stealth public key. ERC-5564 scheme 1: P_stealth = P_spend + (s_h mod n)·G,
 * returned as a 65-byte uncompressed public key.
 */
export function getStealthPublicKey({
    spendingPublicKey,
    hashedSharedSecret
}: {
    spendingPublicKey: Hex
    hashedSharedSecret: Uint8Array
}): Uint8Array {
    const sharedSecretScalar = bytesToNumberBE(hashedSharedSecret) % secp256k1.Point.CURVE().n

    return secp256k1.Point.fromHex(spendingPublicKey.slice(2))
        .add(secp256k1.Point.BASE.multiply(sharedSecretScalar))
        .toBytes(false)
}
