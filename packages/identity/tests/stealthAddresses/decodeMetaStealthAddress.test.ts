import { describe, it, expect } from "@jest/globals"

import { decodeMetaStealthAddress } from "../../src/stealthAddresses/decodeMetaStealthAddress"
import { encodeMetaStealthAddress } from "../../src/stealthAddresses/encodeMetaStealthAddress"
import {
    deriveKeys,
    encodeMetaStealthAddressUri,
    Hex,
    InvalidMetaStealthAddressError
} from "@coordination-network/identity"
import { seededSecret } from "../helpers"
import { concatBytes } from "@noble/hashes/utils"
import { bytesToHex, hexToBytes } from "../../src/bytes"

describe("decodeMetaStealthAddress", () => {
    it("throws on an public key that is too long", () => {
        const { spending, viewing } = deriveKeys(seededSecret(0))

        const metaStealthAddress: Hex = `${spending.publicKey}${viewing.publicKey.slice(2)}`
        const longMetaStealthAddress = concatBytes(hexToBytes(metaStealthAddress), new Uint8Array(1))

        expect(() => decodeMetaStealthAddress(bytesToHex(longMetaStealthAddress))).toThrow(
            InvalidMetaStealthAddressError
        )
    })

    it("round-trips what encodeMetaStealthAddress produces", () => {
        const { spending, viewing } = deriveKeys(seededSecret(1))

        const meta = encodeMetaStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey
        })
        const decoded = decodeMetaStealthAddress(meta)

        expect(decoded.spendingPublicKey).toBe(spending.publicKey)
        expect(decoded.viewingPublicKey).toBe(viewing.publicKey)
    })

    it("decodes the st:eth: display form to the same keys", () => {
        const { spending, viewing } = deriveKeys(seededSecret(2))

        const meta = encodeMetaStealthAddressUri({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey
        })
        const decoded = decodeMetaStealthAddress(meta)

        expect(decoded.spendingPublicKey).toBe(spending.publicKey)
        expect(decoded.viewingPublicKey).toBe(viewing.publicKey)
    })
})
