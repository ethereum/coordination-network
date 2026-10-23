/**
 * Replays `binding-vectors.json` through the library: a binding-scheme change
 * must fail here, forcing deliberate vector regeneration.
 */

import { describe, it, expect } from "@jest/globals"
import { keccak_256 } from "@noble/hashes/sha3"
import {
    deriveKeys,
    computeConfirmationKeyHash,
    buildDeviceBindingMessage,
    buildAccountBindingMessage,
    buildBindingMessages,
    signAccountBinding,
    verifyAccountBindingSignature,
    verifyDeviceBindingSignature,
    verifyCredentialBinding,
    BINDING_NONCE_LENGTH
} from "../src"
import type { Hex } from "../src/types"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "../src/bytes"
import { seededCommitment, seededNonce, seededP256Key } from "./helpers"
import vectorsDocument from "./vectors/binding-vectors.json"
import eddsaVectorsDocument from "./vectors/eddsa-vectors.json"

interface Vector {
    deviceSecret: Hex
    nonce: Hex
    confirmationKey: Hex
    confirmationKeyHash: Hex
    networkId: Hex
    holderKeyCommitment: Hex
    requestCommitment: Hex
    deviceBindingMessage: Hex
    accountBindingMessage: Hex
    accountDigest: Hex
    sigA: Hex
    sigB: Hex
}

const { scheme, vectors } = vectorsDocument as unknown as {
    scheme: {
        bindingNonceLength: number
        confirmationKeyHash: string
        sigA: string
        sigB: string
    }
    vectors: Vector[]
}

const eddsaVectors = eddsaVectorsDocument.vectors

/** Rebuilds the EIP-191 personal-sign digest exactly as `binding.ts` does. */
function eip191Digest(message: Uint8Array): Uint8Array {
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${String(message.length)}`)

    return keccak_256(concatBytes(prefix, message))
}

describe("committed binding vectors — header", () => {
    it("echoes the current normative scheme constants", () => {
        expect(scheme.bindingNonceLength).toBe(BINDING_NONCE_LENGTH)
        expect(scheme.confirmationKeyHash).toBe("RFC7638-JWK-thumbprint")
        expect(scheme.sigA).toBe("EIP-191 + RFC6979 lowS secp256k1 compact")
        expect(scheme.sigB).toBe("ECDSA-P256-SHA256")
    })

    it("contains exactly the six device secrets reused from the derivation vectors", () => {
        expect(vectors).toHaveLength(6)
    })
})

describe("committed binding vectors — replay", () => {
    it.each(vectors.map((vector, index) => [vector.deviceSecret, vector, index] as const))(
        "reproduces every field for %s",
        (_deviceSecret, vector, index) => {
            const keys = deriveKeys(vector.deviceSecret)
            const nonce = hexToBytes(vector.nonce)

            expect(nonce).toHaveLength(BINDING_NONCE_LENGTH)

            // nonce/confirmationKey match the seeded generators also used by generate-binding-vectors.ts for this index.
            expect(bytesToHex(seededNonce(index))).toBe(vector.nonce)
            expect(bytesToHex(seededP256Key(index).publicKey)).toBe(vector.confirmationKey)
            expect(vector.holderKeyCommitment).toBe(
                `0x${BigInt(eddsaVectors[index].commitment).toString(16).padStart(64, "0")}`
            )
            expect(bytesToHex(seededCommitment("vector-request", index))).toBe(vector.requestCommitment)

            expect(computeConfirmationKeyHash(vector.confirmationKey)).toBe(vector.confirmationKeyHash)

            // Convenience wrapper and low-level spec-literal builders must agree on the same bytes.
            const built = buildBindingMessages(
                nonce,
                keys.account.uncompressedPublicKey,
                vector.confirmationKey,
                vector.holderKeyCommitment,
                vector.requestCommitment
            )
            expect(built.networkId).toBe(vector.networkId)
            expect(bytesToHex(built.deviceBindingMessage)).toBe(vector.deviceBindingMessage)
            expect(bytesToHex(built.accountBindingMessage)).toBe(vector.accountBindingMessage)

            expect(
                bytesToHex(
                    buildDeviceBindingMessage(
                        nonce,
                        vector.networkId,
                        vector.holderKeyCommitment,
                        vector.requestCommitment
                    )
                )
            ).toBe(vector.deviceBindingMessage)
            expect(hexToBytes(vector.deviceBindingMessage)).toHaveLength(128)
            expect(bytesToHex(buildAccountBindingMessage(nonce, vector.confirmationKey, vector.networkId))).toBe(
                vector.accountBindingMessage
            )

            const digest = eip191Digest(hexToBytes(vector.accountBindingMessage))
            expect(bytesToHex(digest)).toBe(vector.accountDigest)

            // Re-signing reproduces the committed sigA byte-for-byte (RFC-6979 determinism).
            const resigned = signAccountBinding(keys.account.privateKey, nonce, vector.confirmationKey)
            expect(resigned.networkId).toBe(vector.networkId)
            expect(resigned.signature).toBe(vector.sigA)

            expect(
                verifyAccountBindingSignature({
                    nonce,
                    confirmationKey: vector.confirmationKey,
                    accountPublicKey: keys.account.uncompressedPublicKey,
                    signature: vector.sigA
                })
            ).toBe(true)

            expect(
                verifyDeviceBindingSignature({
                    nonce,
                    networkId: vector.networkId,
                    confirmationKey: vector.confirmationKey,
                    holderKeyCommitment: vector.holderKeyCommitment,
                    requestCommitment: vector.requestCommitment,
                    signature: vector.sigB
                })
            ).toBe(true)

            expect(
                verifyCredentialBinding({
                    nonce,
                    accountPublicKey: keys.account.uncompressedPublicKey,
                    confirmationKey: vector.confirmationKey,
                    holderKeyCommitment: vector.holderKeyCommitment,
                    requestCommitment: vector.requestCommitment,
                    accountSignature: vector.sigA,
                    deviceSignature: vector.sigB
                })
            ).toEqual({ valid: true, networkId: vector.networkId })
        }
    )
})
