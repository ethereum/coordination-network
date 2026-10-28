/**
 * Unit tests for the byte helpers that are not already covered incidentally by
 * the derivation and binding suites. Base64url exists solely to build the
 * RFC 7638 JWK thumbprint in §11.2, so its vectors are RFC 4648 §10's, with
 * `+/` mapped to `-_` and padding stripped.
 */
import { describe, it, expect } from "@jest/globals"
import { base64urlToBytes, bytesToBase64url, utf8ToBytes } from "../src/bytes"

describe("bytesToBase64url", () => {
    it.each([
        ["", ""],
        ["f", "Zg"],
        ["fo", "Zm8"],
        ["foo", "Zm9v"],
        ["foob", "Zm9vYg"],
        ["fooba", "Zm9vYmE"],
        ["foobar", "Zm9vYmFy"]
    ])("encodes %p unpadded", (input, expected) => {
        expect(bytesToBase64url(utf8ToBytes(input))).toBe(expected)
    })

    it("emits no padding and uses the URL-safe alphabet", () => {
        const all = bytesToBase64url(Uint8Array.from({ length: 256 }, (_unused, index) => index))

        expect(all).not.toMatch(/[+/=]/)
        expect(all).toMatch(/^[A-Za-z0-9_-]+$/)
    })

    it("encodes a 32-byte coordinate to 43 characters", () => {
        expect(bytesToBase64url(new Uint8Array(32))).toHaveLength(43)
    })

    it("round-trips every byte through the decoder", () => {
        const bytes = Uint8Array.from({ length: 256 }, (_unused, index) => index)
        expect(base64urlToBytes(bytesToBase64url(bytes))).toEqual(bytes)
    })

    it.each(["a", "ab=", "ab+", "ab/"])("rejects invalid encoding %p", (encoded) => {
        expect(() => base64urlToBytes(encoded)).toThrow("expected unpadded base64url")
    })

    it.each(["AB", "AAB"])("rejects non-zero trailing bits in %p", (encoded) => {
        expect(() => base64urlToBytes(encoded)).toThrow("non-canonical trailing bits")
    })
})
