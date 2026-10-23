import { describe, it, expect } from "@jest/globals"
import { deriveKeys, InvalidMetaStealthAddressError } from "@coordination-network/identity"
import { metaStealthAddressFromKeys, displayMetaStealthAddress } from "../src/meta"
import { Hex } from "../src/types"

const deviceSecrets: Hex[] = [
    `0x${"11".repeat(32)}` as Hex,
    `0x${"22".repeat(32)}` as Hex,
    `0x${"a1b2c3d4e5f6".repeat(5)}${"a1b2".repeat(1)}` as Hex,
    `0x${"deadbeef".repeat(8)}` as Hex
]

describe("metaStealthAddressFromKeys", () => {
    for (const deviceSecret of deviceSecrets) {
        it(`encodes spending-then-viewing compressed keys for device secret ${deviceSecret}`, () => {
            const keys = deriveKeys(deviceSecret)
            const meta = metaStealthAddressFromKeys(keys)

            expect(meta).toHaveLength(134)
            expect(meta.slice(0, 2)).toBe("0x")
            expect(meta).toBe(`${keys.spending.publicKey}${keys.viewing.publicKey.slice(2)}`)
        })
    }

    it("rejects a spending public key truncated to 32 bytes", () => {
        const keys = deriveKeys(deviceSecrets[0])
        const truncated = {
            ...keys,
            spending: { ...keys.spending, publicKey: keys.spending.publicKey.slice(0, -2) as Hex }
        }

        expect(() => metaStealthAddressFromKeys(truncated)).toThrow(InvalidMetaStealthAddressError)
    })

    it("rejects a spending public key with an invalid 0x04 prefix", () => {
        const keys = deriveKeys(deviceSecrets[0])
        const badPrefix = `0x04${keys.spending.publicKey.slice(4)}` as Hex
        const mutated = { ...keys, spending: { ...keys.spending, publicKey: badPrefix } }

        expect(() => metaStealthAddressFromKeys(mutated)).toThrow(InvalidMetaStealthAddressError)
    })

    it("rejects an off-curve viewing public key", () => {
        const keys = deriveKeys(deviceSecrets[0])
        const offCurve = `0x02${"ff".repeat(32)}` as Hex
        const mutated = { ...keys, viewing: { ...keys.viewing, publicKey: offCurve } }

        expect(() => metaStealthAddressFromKeys(mutated)).toThrow(InvalidMetaStealthAddressError)
    })
})

describe("displayMetaStealthAddress", () => {
    it("prepends the st:eth: prefix to a meta-address", () => {
        const keys = deriveKeys(deviceSecrets[0])
        const meta = metaStealthAddressFromKeys(keys)

        expect(displayMetaStealthAddress(meta)).toBe(`st:eth:${meta}`)
    })
})
