import { keccak_256 } from "@noble/hashes/sha3"
import { Address } from "../types"
import { bytesToHex } from "../bytes"
import { InvalidPublicKeyLengthError } from "../errors"

/**
 * Derive Ethereum address from public key: keccak256 of the 64-byte X || Y
 * coordinates (65 bytes without 0x04 prefix stripped), then last 20 bytes.
 */
export function publicKeyToAddress(publicKey: Uint8Array): Address {
    if (publicKey.length !== 65) {
        throw new InvalidPublicKeyLengthError()
    }
    const publicKeyHash = keccak_256(publicKey.slice(1))

    return `0x${bytesToHex(publicKeyHash).slice(-40)}`
}
