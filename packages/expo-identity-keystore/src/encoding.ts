import { p256 } from "@noble/curves/p256"

/** A P-256 public key in JWK form (RFC 7518 §6.2), base64url-encoded, no padding. */
export interface Jwk {
    kty: "EC"
    crv: "P-256"
    x: string
    y: string
}

/** Decodes a base64 string to raw bytes. */
export function base64ToBytes(base64: string): Uint8Array {
    const binary = globalThis.atob(base64)
    const bytes = new Uint8Array(binary.length)

    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
    }

    return bytes
}

/** Encodes raw bytes to a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = ""

    for (let i = 0; i < bytes.length; i += 1) {
        binary += String.fromCharCode(bytes[i])
    }

    return globalThis.btoa(binary)
}

function base64ToBase64Url(base64: string): string {
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Converts a DER-encoded P-256 ECDSA signature (Secure Enclave / Android
 * Keystore) to 64-byte compact `r || s`, normalising `s` to its low-S form
 * (Keystore signatures are not s-normalized).
 */
export function derToCompact(der: Uint8Array): Uint8Array {
    return p256.Signature.fromDER(der).normalizeS().toCompactRawBytes()
}

/** Converts a 65-byte SEC1 uncompressed P-256 point (`0x04 || X || Y`) to a JWK. */
export function sec1ToJwk(uncompressed: Uint8Array): Jwk {
    if (uncompressed.length !== 65 || uncompressed[0] !== 0x04) {
        throw new Error("sec1ToJwk: expected a 65-byte SEC1 uncompressed point (0x04 || X || Y)")
    }

    return {
        kty: "EC",
        crv: "P-256",
        x: base64ToBase64Url(bytesToBase64(uncompressed.slice(1, 33))),
        y: base64ToBase64Url(bytesToBase64(uncompressed.slice(33, 65)))
    }
}
