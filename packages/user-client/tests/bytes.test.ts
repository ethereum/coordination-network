import { describe, it, expect } from "@jest/globals"
import { hexToBytes, bytesToHex, concatBytes, numberToWord, addressToWord } from "../src/bytes"
import { UserClientError } from "../src/errors"

describe("hexToBytes", () => {
    it("rejects a string without a 0x prefix", () => {
        expect(() => hexToBytes("abcd" as never)).toThrow(UserClientError)
    })

    it("rejects an odd-length hex string", () => {
        expect(() => hexToBytes("0xabc")).toThrow(UserClientError)
    })

    it("rejects a string containing non-hex characters", () => {
        expect(() => hexToBytes("0xzz")).toThrow(UserClientError)
    })

    it("parses a well-formed hex string", () => {
        expect(hexToBytes("0xdeadbeef")).toEqual(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))
    })
})

describe("bytesToHex / hexToBytes round-trip", () => {
    it("round-trips bytes through hex", () => {
        const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xab])
        expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
    })

    it("round-trips hex through bytes", () => {
        const hex = "0x0123456789abcdef"
        expect(bytesToHex(hexToBytes(hex))).toBe(hex)
    })
})

describe("concatBytes", () => {
    it("joins three arrays correctly", () => {
        const a = new Uint8Array([1, 2])
        const b = new Uint8Array([3])
        const c = new Uint8Array([4, 5, 6])
        expect(concatBytes(a, b, c)).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
    })
})

describe("numberToWord", () => {
    it("encodes 1 as 31 zero bytes then 0x01", () => {
        const word = numberToWord(1)
        expect(word).toHaveLength(32)
        expect(word.slice(0, 31)).toEqual(new Uint8Array(31))
        expect(word[31]).toBe(1)
    })

    it("encodes 0 as all zero bytes", () => {
        expect(numberToWord(0)).toEqual(new Uint8Array(32))
    })

    it("encodes 256 with 0x01 in the second-to-last byte", () => {
        const word = numberToWord(256)
        expect(word[30]).toBe(1)
        expect(word[31]).toBe(0)
    })

    it("rejects a negative number", () => {
        expect(() => numberToWord(-1)).toThrow(UserClientError)
    })

    it("rejects a non-integer", () => {
        expect(() => numberToWord(1.5)).toThrow(UserClientError)
    })
})

describe("addressToWord", () => {
    it("left-pads a 20-byte address into 32 bytes, address in the last 20 bytes", () => {
        const address = "0x1234567890123456789012345678901234567890" as const
        const word = addressToWord(address)
        expect(word).toHaveLength(32)
        expect(word.slice(0, 12)).toEqual(new Uint8Array(12))
        expect(word.slice(12)).toEqual(hexToBytes(address))
    })

    it("rejects an address that isn't exactly 20 bytes", () => {
        expect(() => addressToWord("0x1234" as never)).toThrow(UserClientError)
    })
})
describe("error messages", () => {
    it("never echo the input, which may be a private key", () => {
        const secret = `0X${"ab".repeat(32)}`

        expect(() => hexToBytes(secret as never)).toThrow(/^(?!.*abababab).*$/)
        expect(() => hexToBytes(`0x${"ab".repeat(31)}z1` as never)).toThrow(/^(?!.*abababab).*$/)
    })

    it("names the type when a JSON-parsed string reaches numberToWord", () => {
        expect(() => numberToWord("31337" as never)).toThrow(/string/)
    })
})
