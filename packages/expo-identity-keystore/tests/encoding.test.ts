import { describe, expect, it } from "@jest/globals"
import { p256 } from "@noble/curves/p256"
import { base64ToBytes, bytesToBase64, derToCompact, sec1ToJwk } from "../src/encoding"

describe("base64ToBytes / bytesToBase64", () => {
    it("round-trips arbitrary bytes", () => {
        const bytes = new Uint8Array([0, 1, 2, 253, 254, 255])
        expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes)
    })
})

describe("derToCompact", () => {
    it("normalises a high-S DER signature to a low-S compact one noble accepts", () => {
        const privateKey = p256.utils.randomSecretKey()
        const publicKey = p256.getPublicKey(privateKey, false)
        const message = new TextEncoder().encode("derToCompact test vector")

        const signature = p256.sign(message, privateKey, { prehash: true, lowS: false })
        const n = p256.CURVE.n
        const highS = signature.hasHighS() ? signature : new p256.Signature(signature.r, n - signature.s)
        expect(highS.hasHighS()).toBe(true)

        const compact = derToCompact(highS.toDERRawBytes())
        expect(compact).toHaveLength(64)
        expect(p256.Signature.fromCompact(compact).hasHighS()).toBe(false)
        expect(p256.verify(compact, message, publicKey, { prehash: true, lowS: true })).toBe(true)
    })

    it("throws on a malformed DER signature", () => {
        expect(() => derToCompact(new Uint8Array([0x00, 0x01, 0x02]))).toThrow()
    })
})

describe("sec1ToJwk", () => {
    it("matches a known SEC1 -> JWK vector (P-256 private key 0x0101...01)", () => {
        const publicKey = p256.getPublicKey(new Uint8Array(32).fill(1), false)

        expect(sec1ToJwk(publicKey)).toEqual({
            kty: "EC",
            crv: "P-256",
            x: "b_A7lJJBzh2t1DUZ5pYOCoW0GmmgXDKBA6orzhWUyhY",
            y: "PE91OlW_AdxT9sCwx-7ni0DG_30lqW4igrmJzvccFEo"
        })
    })

    it("rejects a point that isn't 65-byte SEC1 uncompressed", () => {
        expect(() => sec1ToJwk(new Uint8Array(33))).toThrow()
    })

    it("rejects a real compressed point (0x02/0x03 prefix, 33 bytes)", () => {
        const compressed = p256.getPublicKey(new Uint8Array(32).fill(1), true)
        expect(compressed).toHaveLength(33)
        expect([0x02, 0x03]).toContain(compressed[0])
        expect(() => sec1ToJwk(compressed)).toThrow()
    })
})
