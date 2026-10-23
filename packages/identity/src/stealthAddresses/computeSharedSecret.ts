import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import { Hex } from "../types"

/**
 * The ERC-5564 hashed shared secret: keccak256 of the 33-byte compressed
 * ECDH point.
 *
 * The sender can pass (ephemeralPrivateKey, viewingPublicKey).
 * The recipient can pass (viewingPrivateKey, ephemeralPublicKey).
 */
export function computeSharedSecret({ privateKey, publicKey }: { privateKey: Hex; publicKey: Hex }): Uint8Array {
    const sharedSecret = secp256k1.getSharedSecret(privateKey.slice(2), publicKey.slice(2), true)

    return keccak_256(sharedSecret)
}
