import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToNumberBE, numberToBytesBE } from "@noble/curves/utils"
import { Hex } from "../types"
import { bytesToHex, hexToBytes } from "../bytes"
import { computeSharedSecret } from "./computeSharedSecret"

/**
 * Recovers the private key controlling a stealth address,
 * (p_spend + s_h) mod n.
 */
export function generateStealthPrivateKey({
    ephemeralPublicKey,
    viewingPrivateKey,
    spendingPrivateKey
}: {
    ephemeralPublicKey: Hex
    viewingPrivateKey: Hex
    spendingPrivateKey: Hex
}): Hex {
    const secretHash = computeSharedSecret({
        privateKey: viewingPrivateKey,
        publicKey: ephemeralPublicKey
    })

    const privateKey =
        (bytesToNumberBE(hexToBytes(spendingPrivateKey)) + bytesToNumberBE(secretHash)) % secp256k1.Point.CURVE().n

    return bytesToHex(numberToBytesBE(privateKey, 32))
}
