import { describe, it, expect } from "@jest/globals"
import { secp256k1 } from "@noble/curves/secp256k1"

import { generateEphemeralKey } from "../../src/stealthAddresses/generateEphemeralKey"
import { bytesToHex, hexToBytes } from "../../src/bytes"
import { isValidScalar } from "../../src/keypair"

describe("generateEphemeralKey", () => {
    it("returns a keypair with a valid scalar in [1, n)", () => {
        const ephemeral = generateEphemeralKey()

        expect(isValidScalar(hexToBytes(ephemeral.privateKey))).toBe(true)
        expect(bytesToHex(secp256k1.getPublicKey(hexToBytes(ephemeral.privateKey), true))).toBe(ephemeral.publicKey)
    })

    it("returns a different key on every call", () => {
        expect(generateEphemeralKey().privateKey).not.toBe(generateEphemeralKey().privateKey)
    })
})
