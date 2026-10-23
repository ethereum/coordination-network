import { describe, it, expect } from "@jest/globals"

import { encodeMetaStealthAddressUri } from "../../src/stealthAddresses/encodeMetaStealthAddressUri"
import { encodeMetaStealthAddress } from "../../src/stealthAddresses/encodeMetaStealthAddress"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

describe("encodeMetaStealthAddressUri", () => {
    it("encodes meta stealth address with st:eth:", () => {
        const { spending, viewing } = deriveKeys(seededSecret(0))

        const publicKeys = {
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey
        }

        expect(encodeMetaStealthAddressUri(publicKeys)).toBe(`st:eth:${encodeMetaStealthAddress(publicKeys)}`)
    })
})
