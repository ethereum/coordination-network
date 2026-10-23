import { describe, it, expect } from "@jest/globals"

import { generateStealthAddress } from "../../src/stealthAddresses/generateStealthAddress"
import { seededEphemeralKey } from "./helpers"
import { deriveKeys } from "@coordination-network/identity"
import { seededSecret } from "../helpers"

// Conformance is asserted against ScopeLift's SDK in
// tests/stealth-crosschecks.test.ts, and regressions are pinned by the
// committed vectors. This file holds the behavioural properties only.
describe("generateStealthAddress", () => {
    it("derives a different address per ephemeral key (fresh account per load)", () => {
        const { spending, viewing } = deriveKeys(seededSecret(0))

        const first = generateStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey,
            ephemeralPrivateKey: seededEphemeralKey(0).privateKey
        })
        const second = generateStealthAddress({
            spendingPublicKey: spending.publicKey,
            viewingPublicKey: viewing.publicKey,
            ephemeralPrivateKey: seededEphemeralKey(1).privateKey
        })

        expect(first).not.toBe(second)
    })
})
