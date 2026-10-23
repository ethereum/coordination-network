import { keccak_256 } from "@noble/hashes/sha3"
import type { Hex } from "./types"
import { bytesToHex, concatBytes, toBytes, utf8ToBytes } from "./bytes"
import { DOMAIN_NETWORK_ID } from "./constants"

function publicKeyCoordinates(uncompressedPublicKey: Uint8Array | Hex, caller: string): Uint8Array {
    const bytes = toBytes(uncompressedPublicKey)

    if (bytes.length === 65 && bytes[0] === 0x04) {
        return bytes.slice(1)
    }

    if (bytes.length === 64) {
        return bytes
    }

    throw new TypeError(`${caller}: expected a 65-byte 0x04-prefixed or 64-byte raw uncompressed public key`)
}

/**
 * Computes a user's bytes32 `networkId` from an uncompressed secp256k1 public
 * key (65-byte SEC1 `0x04`-prefixed or 64-byte raw `X || Y`).
 *
 * NORMATIVE: `networkId = keccak256(utf8(DOMAIN_NETWORK_ID) || X || Y)` — the
 * SEC1 prefix is stripped.
 */
export function computeNetworkId(uncompressedPublicKey: Uint8Array | Hex): Hex {
    const coordinates = publicKeyCoordinates(uncompressedPublicKey, "computeNetworkId")

    return bytesToHex(keccak_256(concatBytes(utf8ToBytes(DOMAIN_NETWORK_ID), coordinates)))
}

/**
 * Computes a member's bytes32 id from the same public key forms.
 *
 * NORMATIVE: `memberNetworkId = keccak256(X || Y)`. The last 20 bytes are the
 * member's auth address, which `NetworkMemberRegistry` reads.
 */
export function computeMemberNetworkId(uncompressedPublicKey: Uint8Array | Hex): Hex {
    const coordinates = publicKeyCoordinates(uncompressedPublicKey, "computeMemberNetworkId")

    return bytesToHex(keccak_256(coordinates))
}
