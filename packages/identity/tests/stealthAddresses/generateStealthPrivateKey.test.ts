import { describe, it, expect } from "@jest/globals"

import { generateStealthAddress } from "../../src/stealthAddresses/generateStealthAddress"
import { generateStealthPrivateKey } from "../../src/stealthAddresses/generateStealthPrivateKey"
import { hexToBytes } from "../../src/bytes"
import { isValidScalar } from "../../src/keypair"
import { privateKeyToAddress, seededEphemeralKey } from "./helpers"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

describe("generateStealthAddress", () => {
    it.each([0, 1, 2, 3, 4])("round-trip: sender's address is controlled by recipient's derived key %i", (index) => {
        const { spending, viewing } = deriveKeys(seededSecret(index))
        const ephemeral = seededEphemeralKey(index)

        const stealthAddress = generateStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey,
            ephemeralPrivateKey: ephemeral.privateKey
        })

        const stealthPrivateKey = generateStealthPrivateKey({
            ephemeralPublicKey: ephemeral.publicKey,
            viewingPrivateKey: viewing.privateKey,
            spendingPrivateKey: spending.privateKey
        })

        expect(privateKeyToAddress(stealthPrivateKey)).toBe(stealthAddress)
    })

    it("derives a stealth private key that differs from the spending private key", () => {
        const { spending, viewing } = deriveKeys(seededSecret(0))
        const ephemeral = seededEphemeralKey(1)

        const stealthPrivateKey = generateStealthPrivateKey({
            ephemeralPublicKey: ephemeral.publicKey,
            viewingPrivateKey: viewing.privateKey,
            spendingPrivateKey: spending.privateKey
        })

        expect(stealthPrivateKey).not.toBe(spending.privateKey)
        expect(isValidScalar(hexToBytes(stealthPrivateKey))).toBe(true)
    })
})
