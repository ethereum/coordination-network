import { createHash } from "node:crypto"
import { randomUuid } from "../src/crypto"
import {
    base64urlToBytes,
    bytesToBase64url,
    compressedPointToJwk,
    Jwk,
    jwkThumbprint,
    jwkToCompressedPoint,
    jwkToPublicKeyBytes,
    LocalP256Signer,
    verifyP256
} from "@coordination-network/credential"

describe("base64url helpers", () => {
    it("round-trips bytes", () => {
        const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252])
        expect(base64urlToBytes(bytesToBase64url(bytes))).toEqual(bytes)
    })

    it("tolerates trailing = padding a client may send (RFC 4648 §5 permits omitting it)", () => {
        const bytes = Uint8Array.from([1])
        expect(bytesToBase64url(bytes)).toBe("AQ")
        expect(base64urlToBytes("AQ==")).toEqual(bytes)
    })

    it("still rejects + and / and other non-base64url characters", () => {
        expect(() => base64urlToBytes("AQ+")).toThrow(/invalid base64url character/)
        expect(() => base64urlToBytes("AQ/")).toThrow(/invalid base64url character/)
    })
})

describe("SEC1 <-> JWK conversion", () => {
    it("round-trips a compressed point through JWK form", async () => {
        const signer = LocalP256Signer.generate()
        const jwk = await signer.getPublicKeyJwk()
        expect(compressedPointToJwk(jwkToCompressedPoint(jwk))).toEqual(jwk)
    })

    it("rejects bytes that are not a curve point", () => {
        expect(() => compressedPointToJwk(new Uint8Array(33).fill(0xff))).toThrow()
    })

    it("rejects a JWK with truncated coordinates", () => {
        const bad = { kty: "EC", crv: "P-256", x: "AAAA", y: "AAAA" } as Jwk
        expect(() => jwkToPublicKeyBytes(bad)).toThrow()
    })
})

describe("RFC 7638 thumbprint", () => {
    it("hashes the ordered required members", async () => {
        const jwk = await LocalP256Signer.generate().getPublicKeyJwk()
        const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`
        const expected = Uint8Array.from(createHash("sha256").update(canonical, "utf8").digest())
        expect(jwkThumbprint(jwk)).toEqual(expected)
    })
})

describe("LocalP256Signer", () => {
    it("rejects a digest with the wrong width before signing", async () => {
        const signer = LocalP256Signer.generate()
        await expect(signer.signDigest(new Uint8Array(31))).rejects.toThrow("P-256 digest must be 32 bytes")
    })

    it("treats malformed runtime signature values as a verification failure", async () => {
        const signer = LocalP256Signer.generate()
        const key = jwkToPublicKeyBytes(await signer.getPublicKeyJwk())
        expect(verifyP256(new Uint8Array(1), null as unknown as Uint8Array, key)).toBe(false)
    })
    it("signs in message mode with a raw 64-byte signature that verifies", async () => {
        const signer = LocalP256Signer.generate()
        const message = new TextEncoder().encode("hello counter")
        const signature = await signer.sign(message)
        expect(signature).toHaveLength(64)
        const publicKey = jwkToPublicKeyBytes(await signer.getPublicKeyJwk())
        expect(verifyP256(message, signature, publicKey)).toBe(true)
        expect(verifyP256(new TextEncoder().encode("other"), signature, publicKey)).toBe(false)
    })

    it("rejects a private key that is not 32 bytes", () => {
        expect(() => new LocalP256Signer(new Uint8Array(16))).toThrow()
    })

    it("verifyP256 returns false instead of throwing on garbage input", () => {
        expect(verifyP256(new Uint8Array(1), new Uint8Array(3), new Uint8Array(2))).toBe(false)
    })
})

it("generates RFC 4122 version 4 UUIDs with the required variant", () => {
    expect(randomUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})
