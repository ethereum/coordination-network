import { describe, expect, it } from "@jest/globals"
import { bigintToBytes32, bytesToHex, hexToBytes } from "../src/hex"

describe("hex", () => {
    it("round-trips bytes through hex", () => {
        const bytes = Uint8Array.from([0, 1, 16, 255])
        expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
        expect(bytesToHex(bytes)).toBe("0x000110ff")
    })

    it("encodes a bigint as 32 big-endian bytes, left-padded", () => {
        expect(bigintToBytes32(1n)).toEqual(Uint8Array.from([...new Array(31).fill(0), 1]))
        expect(bigintToBytes32(0n)).toEqual(new Uint8Array(32))
    })
})
