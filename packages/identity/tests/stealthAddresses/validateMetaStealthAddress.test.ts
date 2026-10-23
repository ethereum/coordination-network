import { describe, it, expect } from "@jest/globals"

import { validateMetaStealthAddress } from "../../src/stealthAddresses/validateMetaStealthAddress"
import { encodeMetaStealthAddress } from "../../src/stealthAddresses/encodeMetaStealthAddress"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

describe("validateMetaStealthAddress", () => {
    it("returns true for a well-formed meta-stealth address", () => {
        const { spending, viewing } = deriveKeys(seededSecret(0))

        const meta = encodeMetaStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey
        })

        expect(validateMetaStealthAddress(meta)).toBe(true)
    })

    it("returns false for a missing 0x prefix", () => {
        const { spending, viewing } = deriveKeys(seededSecret(1))
        const meta = encodeMetaStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey
        })

        expect(validateMetaStealthAddress(meta.slice(2))).toBe(false)
    })

    it("returns false for a wrong length", () => {
        const { spending } = deriveKeys(seededSecret(2))

        expect(validateMetaStealthAddress(spending.publicKey)).toBe(false)
        expect(validateMetaStealthAddress("0x")).toBe(false)
    })

    it("returns false for non-hex characters", () => {
        expect(validateMetaStealthAddress(`0x${"zz".repeat(66)}`)).toBe(false)
    })

    it("returns false for an uncompressed key prefix", () => {
        const { spending, viewing } = deriveKeys(seededSecret(3))
        // Rebuild the spending key with an 0x04 (uncompressed) SEC1 prefix in
        // place of 0x02/0x03. This key then becomes right length, wrong encoding.
        const badPrefix = `0x04${spending.publicKey.slice(4)}${viewing.publicKey.slice(2)}`

        expect(validateMetaStealthAddress(badPrefix)).toBe(false)
    })

    it("returns false for an off-curve spending key", () => {
        const { viewing } = deriveKeys(seededSecret(4))
        // x = 0 satisfies no point on secp256k1, so this is a valid-looking
        // 02-prefixed key (prefix for 33-bytes compressed) that is not on the curve.
        const offCurveSpendingKey = `0x02${"00".repeat(32)}${viewing.publicKey.slice(2)}`

        expect(validateMetaStealthAddress(offCurveSpendingKey)).toBe(false)
    })

    it("returns false for an off-curve viewing key", () => {
        const { spending } = deriveKeys(seededSecret(5))
        const offCurveViewingKey = `${spending.publicKey}02${"00".repeat(32)}`

        expect(validateMetaStealthAddress(offCurveViewingKey)).toBe(false)
    })
})
