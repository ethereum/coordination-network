import { describe, it, expect } from "@jest/globals"

import { metaStealthAddressUri } from "../../src/stealthAddresses/metaStealthAddressUri"
import { encodeMetaStealthAddress } from "../../src/stealthAddresses/encodeMetaStealthAddress"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

describe("metaStealthAddressUri", () => {
    it("prepends st:eth: to an encoded meta stealth address", () => {
        const { spending, viewing } = deriveKeys(seededSecret(0))

        const meta = encodeMetaStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey
        })

        expect(metaStealthAddressUri(meta)).toBe(`st:eth:${meta}`)
    })
})
