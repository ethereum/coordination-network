import { describe, it, expect } from "@jest/globals"

import { checkStealthAddress } from "../../src/stealthAddresses/checkStealthAddress"
import { computeSharedSecret } from "../../src/stealthAddresses/computeSharedSecret"
import { getViewTag } from "../../src/stealthAddresses/getViewTag"
import { generateStealthAddress } from "../../src/stealthAddresses/generateStealthAddress"
import { seededEphemeralKey } from "./helpers"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

/** A full announcement as the sender would publish it, addressed to recipient `index`. */
function announcement(index: number) {
    const { spending, viewing } = deriveKeys(seededSecret(index))
    const ephemeral = seededEphemeralKey(index)

    const stealthAddress = generateStealthAddress({
        spendingPublicKey: spending.publicKey,
        viewingPublicKey: viewing.publicKey,
        ephemeralPrivateKey: ephemeral.privateKey
    })
    const viewTag = getViewTag(
        computeSharedSecret({
            privateKey: ephemeral.privateKey,
            publicKey: viewing.publicKey
        })
    )

    return { spending, viewing, ephemeral, stealthAddress, viewTag }
}

describe("checkStealthAddress", () => {
    it("returns true for an announcement derived from the recipient's own keys", () => {
        const { spending, viewing, ephemeral, stealthAddress, viewTag } = announcement(0)

        expect(
            checkStealthAddress({
                stealthAddress,
                ephemeralPublicKey: ephemeral.publicKey,
                viewTag,
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: spending.publicKey
            })
        ).toBe(true)
    })

    it("returns true for a mixed-case stealth address", () => {
        const { spending, viewing, ephemeral, stealthAddress, viewTag } = announcement(1)
        const mixedCase = `0x${stealthAddress.slice(2).toUpperCase()}` as const

        expect(
            checkStealthAddress({
                stealthAddress: mixedCase,
                ephemeralPublicKey: ephemeral.publicKey,
                viewTag,
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: spending.publicKey
            })
        ).toBe(true)
    })

    it("returns false on a wrong view tag", () => {
        const { spending, viewing, ephemeral, stealthAddress, viewTag } = announcement(2)

        expect(
            checkStealthAddress({
                stealthAddress,
                ephemeralPublicKey: ephemeral.publicKey,
                viewTag: (viewTag + 1) % 256,
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: spending.publicKey
            })
        ).toBe(false)
    })

    it("returns false with someone else's viewing key", () => {
        const { spending, ephemeral, stealthAddress, viewTag } = announcement(3)
        const otherKeyPair = deriveKeys(seededSecret(4))

        expect(
            checkStealthAddress({
                stealthAddress,
                ephemeralPublicKey: ephemeral.publicKey,
                viewTag,
                viewingPrivateKey: otherKeyPair.viewing.privateKey,
                spendingPublicKey: spending.publicKey
            })
        ).toBe(false)
    })

    it("returns false with someone else's spending key", () => {
        const { viewing, ephemeral, stealthAddress, viewTag } = announcement(5)
        const otherKeyPair = deriveKeys(seededSecret(6))

        expect(
            checkStealthAddress({
                stealthAddress,
                ephemeralPublicKey: ephemeral.publicKey,
                viewTag,
                viewingPrivateKey: viewing.privateKey,
                spendingPublicKey: otherKeyPair.spending.publicKey
            })
        ).toBe(false)
    })
})
