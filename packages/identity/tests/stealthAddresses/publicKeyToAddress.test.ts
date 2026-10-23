import { describe, it, expect } from "@jest/globals"

import {
    computeSharedSecret,
    deriveKeys,
    generateEphemeralKey,
    getStealthPublicKey,
    InvalidPublicKeyLengthError,
    publicKeyToAddress
} from "@coordination-network/identity"
import { seededSecret } from "../helpers"
import { secp256k1 } from "@noble/curves/secp256k1"
import { concatBytes } from "../../src/bytes"

describe("publicKeyToAddress", () => {
    it("throws an error when the public key length is invalid", () => {
        const ephemeral = generateEphemeralKey()
        const { spending, viewing } = deriveKeys(seededSecret(0))
        const hashedSharedSecret = computeSharedSecret({
            privateKey: ephemeral.privateKey,
            publicKey: viewing.publicKey
        })

        const publicKey = getStealthPublicKey({ spendingPublicKey: spending.publicKey, hashedSharedSecret })

        const shortPublicKey = publicKey.slice(1)
        const longPublicKey = concatBytes(publicKey, new Uint8Array(1))

        expect(() => publicKeyToAddress(shortPublicKey)).toThrow(InvalidPublicKeyLengthError)
        expect(() => publicKeyToAddress(longPublicKey)).toThrow(InvalidPublicKeyLengthError)
    })

    it("returns a well formed ethereum address", () => {
        // mnemonic:          test test test test test test test test test test test junk
        // Derivation path:   m/44'/60'/0'/0/
        const anvilPrivateKey0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
        const anvilAddress0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

        const publicKey = secp256k1.getPublicKey(anvilPrivateKey0.slice(2), false)

        const address = publicKeyToAddress(publicKey)

        expect(address).toBe(anvilAddress0.toLowerCase())
    })
})
