/**
 * Replays the committed `stealth-vectors.json`: any change to the stealth
 * derivation must fail here, forcing deliberate vector regeneration.
 */

import { describe, it, expect } from "@jest/globals"
import { secp256k1 } from "@noble/curves/secp256k1"

import {
    deriveKeys,
    computeSharedSecret,
    getViewTag,
    generateStealthAddress,
    generateStealthPrivateKey,
    checkStealthAddress,
    encodeMetaStealthAddress,
    decodeMetaStealthAddress,
    META_STEALTH_ADDRESS_LENGTH,
    META_STEALTH_URI_PREFIX
} from "../src"
import type { Hex } from "../src/types"
import { bytesToHex } from "../src/bytes"
import vectorsDocument from "./vectors/stealth-vectors.json"

interface Vector {
    deviceSecret: Hex
    spendingPublicKey: Hex
    viewingPublicKey: Hex
    ephemeralPrivateKey: Hex
    ephemeralPublicKey: Hex
    hashedSharedSecret: Hex
    viewTag: number
    stealthAddress: Hex
    stealthPrivateKey: Hex
    metaStealthAddress: Hex
}

const { scheme, vectors } = vectorsDocument as unknown as {
    scheme: {
        schemeId: number
        curve: string
        hash: string
        sharedSecretEncoding: string
        metaStealthAddressLength: number
        uriPrefix: string
        groupOrder: string
    }
    vectors: Vector[]
}

describe("committed stealth vectors — header", () => {
    it("echoes the current normative scheme constants", () => {
        expect(scheme.schemeId).toBe(1)
        expect(scheme.curve).toBe("secp256k1")
        expect(scheme.hash).toBe("keccak256")
        expect(scheme.sharedSecretEncoding).toBe("SEC1 compressed (33 bytes)")
        expect(scheme.metaStealthAddressLength).toBe(META_STEALTH_ADDRESS_LENGTH)
        expect(scheme.uriPrefix).toBe(META_STEALTH_URI_PREFIX)
        expect(scheme.groupOrder).toBe(`0x${secp256k1.Point.CURVE().n.toString(16)}`)
    })

    it("contains a non-trivial number of vectors", () => {
        expect(vectors.length).toBeGreaterThanOrEqual(8)
    })
})

describe("committed stealth vectors — replay", () => {
    it.each(vectors.map((vector) => [vector.deviceSecret, vector] as const))(
        "reproduces every field for %s",
        (_deviceSecret, vector) => {
            const { spending, viewing } = deriveKeys(vector.deviceSecret)
            expect(spending.publicKey).toBe(vector.spendingPublicKey)
            expect(viewing.publicKey).toBe(vector.viewingPublicKey)

            const hashedSharedSecret = computeSharedSecret({
                privateKey: vector.ephemeralPrivateKey,
                publicKey: vector.viewingPublicKey
            })
            expect(bytesToHex(hashedSharedSecret)).toBe(vector.hashedSharedSecret)
            expect(getViewTag(hashedSharedSecret)).toBe(vector.viewTag)

            expect(
                generateStealthAddress({
                    spendingPublicKey: vector.spendingPublicKey,
                    viewingPublicKey: vector.viewingPublicKey,
                    ephemeralPrivateKey: vector.ephemeralPrivateKey
                })
            ).toBe(vector.stealthAddress)

            expect(
                generateStealthPrivateKey({
                    ephemeralPublicKey: vector.ephemeralPublicKey,
                    viewingPrivateKey: viewing.privateKey,
                    spendingPrivateKey: spending.privateKey
                })
            ).toBe(vector.stealthPrivateKey)

            expect(
                checkStealthAddress({
                    stealthAddress: vector.stealthAddress,
                    ephemeralPublicKey: vector.ephemeralPublicKey,
                    viewTag: vector.viewTag,
                    viewingPrivateKey: viewing.privateKey,
                    spendingPublicKey: vector.spendingPublicKey
                })
            ).toBe(true)

            expect(
                encodeMetaStealthAddress({
                    spendingPublicKey: vector.spendingPublicKey,
                    viewingPublicKey: vector.viewingPublicKey
                })
            ).toBe(vector.metaStealthAddress)

            const decoded = decodeMetaStealthAddress(vector.metaStealthAddress)
            expect(decoded.spendingPublicKey).toBe(vector.spendingPublicKey)
            expect(decoded.viewingPublicKey).toBe(vector.viewingPublicKey)
        }
    )
})
