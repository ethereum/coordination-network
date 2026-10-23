import { bytesToHex as nobleBytesToHex, hexToBytes as nobleHexToBytes } from "@noble/hashes/utils"

import type { Hex } from "./types"
import { InvalidDeviceSecretError, InvalidEcdhSecretError } from "./errors"

const HEX_RE = /^[0-9a-fA-F]*$/

export { utf8ToBytes, concatBytes } from "@noble/hashes/utils"

export function hexToBytes(hex: string): Uint8Array {
    if (typeof hex !== "string" || !hex.startsWith("0x")) {
        throw new TypeError("hexToBytes: expected a string with a 0x prefix")
    }

    const body = hex.slice(2)

    if (body.length % 2 !== 0) {
        throw new TypeError("hexToBytes: expected an even number of hex characters")
    }

    if (!HEX_RE.test(body)) {
        throw new TypeError("hexToBytes: expected only hex characters after the 0x prefix")
    }

    return nobleHexToBytes(body)
}

export function bytesToHex(bytes: Uint8Array): Hex {
    return `0x${nobleBytesToHex(bytes)}`
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

/** Unpadded base64url (RFC 4648 §5) */
export function bytesToBase64url(bytes: Uint8Array): string {
    let out = ""
    let i = 0

    for (; i + 2 < bytes.length; i += 3) {
        const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]

        out +=
            BASE64URL_ALPHABET[(chunk >> 18) & 63] +
            BASE64URL_ALPHABET[(chunk >> 12) & 63] +
            BASE64URL_ALPHABET[(chunk >> 6) & 63] +
            BASE64URL_ALPHABET[chunk & 63]
    }

    const remaining = bytes.length - i

    if (remaining === 1) {
        const chunk = bytes[i] << 16

        out += BASE64URL_ALPHABET[(chunk >> 18) & 63] + BASE64URL_ALPHABET[(chunk >> 12) & 63]
    } else if (remaining === 2) {
        const chunk = (bytes[i] << 16) | (bytes[i + 1] << 8)

        out +=
            BASE64URL_ALPHABET[(chunk >> 18) & 63] +
            BASE64URL_ALPHABET[(chunk >> 12) & 63] +
            BASE64URL_ALPHABET[(chunk >> 6) & 63]
    }

    return out
}

/** Decodes unpadded base64url (RFC 4648 §5). */
export function base64urlToBytes(encoded: string): Uint8Array {
    if (!/^[A-Za-z0-9_-]*$/.test(encoded) || encoded.length % 4 === 1) {
        throw new TypeError("base64urlToBytes: expected unpadded base64url")
    }
    const output = new Uint8Array(Math.floor((encoded.length * 6) / 8))
    let buffer = 0
    let bits = 0
    let offset = 0
    for (const character of encoded) {
        buffer = (buffer << 6) | BASE64URL_ALPHABET.indexOf(character)
        bits += 6
        if (bits >= 8) {
            bits -= 8
            output[offset++] = (buffer >> bits) & 0xff
            buffer &= (1 << bits) - 1
        }
    }
    if (buffer !== 0) throw new TypeError("base64urlToBytes: non-canonical trailing bits")
    return output
}

export function toBytes(value: Uint8Array | Hex): Uint8Array {
    return value instanceof Uint8Array ? value : hexToBytes(value)
}

/** Prepends the SEC1 `0x04` prefix to a 64-byte raw `X || Y` pair (secp256k1 or P-256). */
export function prependUncompressedPrefix(coordinates: Uint8Array): Uint8Array {
    const out = new Uint8Array(65)
    out[0] = 0x04
    out.set(coordinates, 1)
    return out
}

/**
 * Normalizes a device secret to a defensive copy of exactly 32 bytes.
 * Accepts a 32-byte `Uint8Array` or a `0x`-prefixed 64-hex-char string;
 * anything else throws {@link InvalidDeviceSecretError}.
 */
export function normalizeDeviceSecret(secret: Uint8Array | Hex | string): Uint8Array {
    if (secret instanceof Uint8Array) {
        if (secret.length !== 32) {
            throw new InvalidDeviceSecretError()
        }

        return secret.slice()
    }

    if (typeof secret === "string") {
        if (!secret.startsWith("0x") || secret.length !== 66 || !HEX_RE.test(secret.slice(2))) {
            throw new InvalidDeviceSecretError()
        }

        return hexToBytes(secret)
    }

    throw new InvalidDeviceSecretError()
}

/**
 * Normalizes a hardware ECDH shared secret to a defensive copy of exactly 32
 * bytes. Same exactly-32-bytes contract as {@link normalizeDeviceSecret};
 * rethrown as {@link InvalidEcdhSecretError} so callers don't conflate the
 * two secrets by error code.
 */
export function normalizeEcdhSharedSecret(secret: Uint8Array | Hex | string): Uint8Array {
    try {
        return normalizeDeviceSecret(secret)
    } catch (error) {
        if (error instanceof InvalidDeviceSecretError) {
            throw new InvalidEcdhSecretError()
        }

        throw error
    }
}
