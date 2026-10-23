import { describe, it, expect } from "@jest/globals"

import { encodeMetaStealthAddress } from "../../src/stealthAddresses/encodeMetaStealthAddress"
import { InvalidMetaStealthAddressError } from "../../src/errors"
import { hexToBytes } from "../../src/bytes"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

describe("encodeMetaStealthAddress (ERC-6538 scheme 1)", () => {
    it("encodes as the 66-byte compressed spending ‖ viewing concatenation", () => {
        const { spending, viewing } = deriveKeys(seededSecret(0))

        const meta = encodeMetaStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey
        })

        const bytes = hexToBytes(meta)
        expect(bytes).toHaveLength(66)
        expect(bytes.slice(0, 33)).toEqual(hexToBytes(spending.publicKey))
        expect(bytes.slice(33)).toEqual(hexToBytes(viewing.publicKey))
    })

    it("throws on an uncompressed public key", () => {
        const { spending, viewing } = deriveKeys(seededSecret(1))

        expect(() =>
            encodeMetaStealthAddress({
                spendingPublicKey: spending.uncompressedPublicKey,
                viewingPublicKey: viewing.publicKey
            })
        ).toThrow(InvalidMetaStealthAddressError)
    })

    it("throws on an off-curve public key", () => {
        const { viewing } = deriveKeys(seededSecret(2))
        // x = 0 satisfies no point on secp256k1, so this is a valid-looking
        // 02-prefixed key (prefix for 33-bytes compressed) that is not on the curve.
        const offCurvePoint = `0x02${"00".repeat(32)}` as const

        expect(() =>
            encodeMetaStealthAddress({
                spendingPublicKey: offCurvePoint,
                viewingPublicKey: viewing.publicKey
            })
        ).toThrow(InvalidMetaStealthAddressError)
    })

    it("names the offending key when a public key is the wrong length", () => {
        const { spending, viewing } = deriveKeys(seededSecret(3))

        expect(() =>
            encodeMetaStealthAddress({
                spendingPublicKey: spending.publicKey.slice(0, -2) as `0x${string}`,
                viewingPublicKey: viewing.publicKey
            })
        ).toThrow(/spending public key must be 33 bytes/)
    })

    it("names the offending key when a public key has a bad SEC1 prefix", () => {
        const { spending, viewing } = deriveKeys(seededSecret(4))

        expect(() =>
            encodeMetaStealthAddress({
                spendingPublicKey: spending.publicKey,
                viewingPublicKey: `0x04${viewing.publicKey.slice(4)}`
            })
        ).toThrow(/viewing public key must start with 0x02 or 0x03/)
    })

    it("rejects a pair whose lengths compensate to the right total", () => {
        const { spending, viewing } = deriveKeys(seededSecret(5))

        // 32 + 34 bytes still concatenates to 132 hex chars, but splits at the wrong offset.
        expect(() =>
            encodeMetaStealthAddress({
                spendingPublicKey: spending.publicKey.slice(0, -2) as `0x${string}`,
                viewingPublicKey: `${viewing.publicKey}ff`
            })
        ).toThrow(InvalidMetaStealthAddressError)
    })
})
