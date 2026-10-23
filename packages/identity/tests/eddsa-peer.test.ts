/** Unit tests for the fixed NUMS P-256 peer point `Q` (`src/eddsa-peer.ts`). */

import { describe, it, expect } from "@jest/globals"
import { p256 } from "@noble/curves/p256"
import { EDDSA_PEER_POINT_HEX, eddsaPeerPointBytes, computeEddsaPeerPoint } from "../src"
import { hexToBytes } from "../src/bytes"

describe("EDDSA_PEER_POINT_HEX — NUMS provenance", () => {
    it("matches the RFC 9380 hash-to-curve recomputation", () => {
        expect(computeEddsaPeerPoint()).toEqual(hexToBytes(EDDSA_PEER_POINT_HEX))
    })

    it("is a valid on-curve P-256 point", () => {
        expect(() => p256.ProjectivePoint.fromHex(hexToBytes(EDDSA_PEER_POINT_HEX)).assertValidity()).not.toThrow()
    })

    it("is a 65-byte SEC1 uncompressed encoding, 0x04-prefixed", () => {
        const bytes = hexToBytes(EDDSA_PEER_POINT_HEX)
        expect(bytes).toHaveLength(65)
        expect(bytes[0]).toBe(0x04)
    })
})

describe("eddsaPeerPointBytes", () => {
    it("returns bytes equal to EDDSA_PEER_POINT_HEX", () => {
        expect(eddsaPeerPointBytes()).toEqual(hexToBytes(EDDSA_PEER_POINT_HEX))
    })

    it("returns a fresh, independently mutable copy on every call", () => {
        const first = eddsaPeerPointBytes()
        const second = eddsaPeerPointBytes()

        expect(first).not.toBe(second)

        first[0] = 0xff
        expect(second[0]).toBe(0x04)
        expect(eddsaPeerPointBytes()[0]).toBe(0x04)
    })
})
