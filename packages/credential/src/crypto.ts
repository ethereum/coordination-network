import { p256 } from "@noble/curves/nist.js"
import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex, randomBytes } from "@noble/hashes/utils"
import { base64urlToBytes as strictBase64urlToBytes, bytesToBase64url } from "@coordination-network/identity"
import { Jwk } from "./types"
import { DeviceSigner } from "./signer"

export { bytesToBase64url }

/**
 * Padding is optional under RFC 4648 §5 and some clients send it anyway (Python's
 * urlsafe_b64encode, Java's URL encoder), so JWK coordinates are stripped before the strict decode
 * rather than rejected.
 */
export function base64urlToBytes(encoded: string): Uint8Array {
    const unpadded = encoded.replace(/=+$/, "")
    const invalid = unpadded.match(/[^A-Za-z0-9_-]/)
    if (invalid) throw new Error(`invalid base64url character: ${invalid[0]}`)
    return strictBase64urlToBytes(unpadded)
}

/** Uncompressed SEC1 point (65 bytes, 0x04 || x || y) from a P-256 JWK. */
export function jwkToPublicKeyBytes(jwk: Jwk): Uint8Array {
    const x = base64urlToBytes(jwk.x)
    const y = base64urlToBytes(jwk.y)
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || x.length !== 32 || y.length !== 32) {
        throw new Error("expected a P-256 EC JWK with 32-byte coordinates")
    }
    const point = new Uint8Array(65)
    point[0] = 0x04
    point.set(x, 1)
    point.set(y, 33)
    return point
}

/**
 * Registry keys are stored as the compressed SEC1 point (33 bytes, spec 07).
 * Both converters go through the curve, so an off-curve point throws instead
 * of round-tripping garbage.
 */
export function compressedPointToJwk(point: Uint8Array): Jwk {
    const raw = p256.ProjectivePoint.fromHex(point).toRawBytes(false)
    return {
        kty: "EC",
        crv: "P-256",
        x: bytesToBase64url(raw.slice(1, 33)),
        y: bytesToBase64url(raw.slice(33, 65))
    }
}

export function jwkToCompressedPoint(jwk: Jwk): Uint8Array {
    return p256.ProjectivePoint.fromHex(jwkToPublicKeyBytes(jwk)).toRawBytes(true)
}

/** RFC 7638 JWK thumbprint: SHA-256 over the ordered required members. */
export function jwkThumbprint(jwk: Jwk): Uint8Array {
    return sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))
}

/**
 * ECDSA P-256 verification in message mode. lowS is not enforced on verify:
 * we produce low-s signatures ourselves, but external signers (KMS) may not,
 * and JWS does not require it.
 */
export function verifyP256(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean {
    try {
        return p256.verify(signature, sha256(message), publicKey, { lowS: false })
    } catch {
        return false
    }
}

/** RFC 4122 v4 UUID from CSPRNG bytes — node:crypto is unavailable under React Native. */
export function randomUuid(): string {
    const bytes = randomBytes(16)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytesToHex(bytes)

    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * Software P-256 signer. The issuer demo and every test use it; production
 * issuers replace it with a KMS-backed Signer, apps with a secure-element
 * DeviceSigner. Signs in message mode with low-s, raw 64-byte output —
 * exactly the DeviceSigner contract.
 */
export class LocalP256Signer implements DeviceSigner {
    private readonly privateKey: Uint8Array

    constructor(privateKey: Uint8Array) {
        if (privateKey.length !== 32) {
            throw new Error("P-256 private key must be 32 bytes")
        }
        this.privateKey = privateKey
    }

    static generate(): LocalP256Signer {
        return new LocalP256Signer(p256.utils.randomSecretKey())
    }

    async getPublicKeyJwk(): Promise<Jwk> {
        return compressedPointToJwk(p256.getPublicKey(this.privateKey, true))
    }

    async sign(message: Uint8Array): Promise<Uint8Array> {
        return p256.sign(sha256(message), this.privateKey, { lowS: true }).toCompactRawBytes()
    }

    async signDigest(digest: Uint8Array): Promise<Uint8Array> {
        if (digest.length !== 32) throw new Error("P-256 digest must be 32 bytes")
        return p256.sign(digest, this.privateKey, { lowS: true }).toCompactRawBytes()
    }
}
