/**
 * Replays the committed fifth-key vectors (`tests/vectors/eddsa-vectors.json`)
 * against `deriveEddsaKeypair`: a derivation change must fail here, forcing
 * deliberate vector regeneration.
 */

import { describe, it, expect } from "@jest/globals"
import { p256 } from "@noble/curves/p256"
import { deriveEddsaKeypair, EDDSA_PEER_POINT_HEX, eddsaPeerPointBytes, DOMAIN_EDDSA, DOMAIN_EDDSA_PEER } from "../src"
import type { Hex } from "../src/types"
import { hexToBytes, bytesToHex } from "../src/bytes"
import vectorsDocument from "./vectors/eddsa-vectors.json"

interface Vector {
    hardwarePrivateKey: Hex
    hardwarePublicKey: Hex
    ecdhSharedSecret: Hex
    seed: Hex
    secretScalar: string
    publicKey: [string, string]
    commitment: string
}

const { scheme, vectors } = vectorsDocument as unknown as {
    scheme: {
        version: string
        domainEddsa: string
        domainEddsaPeer: string
        peerPoint: string
        seedHash: string
        curve: string
        scalarDerivation: string
        commitment: string
    }
    vectors: Vector[]
}

describe("committed EdDSA fifth-key vectors — header", () => {
    it("echoes the current normative scheme constants", () => {
        // The EdDSA tags stay `/v1/`; the networkId revision does not touch them.
        expect(scheme.version).toBe("v1")
        expect(scheme.domainEddsa).toBe(DOMAIN_EDDSA)
        expect(scheme.domainEddsaPeer).toBe(DOMAIN_EDDSA_PEER)
        expect(scheme.peerPoint).toBe(EDDSA_PEER_POINT_HEX)
        expect(scheme.seedHash).toBe("keccak256")
        expect(scheme.curve).toBe("baby-jubjub")
    })

    it("contains a non-trivial number of vectors", () => {
        expect(vectors.length).toBeGreaterThanOrEqual(12)
    })
})

describe("committed EdDSA fifth-key vectors — replay", () => {
    it.each(vectors.map((vector) => [vector.hardwarePrivateKey, vector] as const))(
        "reproduces both the ECDH leg and the seed pipeline for %s",
        (_hardwarePrivateKey, vector) => {
            // hwPriv reproduces the pinned hardware public key.
            const hardwarePublicKey = bytesToHex(p256.getPublicKey(hexToBytes(vector.hardwarePrivateKey), false))
            expect(hardwarePublicKey).toBe(vector.hardwarePublicKey)

            // ECDH leg: hwPriv * Q reproduces the pinned shared secret.
            const ecdhSharedSecret = bytesToHex(
                p256.getSharedSecret(hexToBytes(vector.hardwarePrivateKey), eddsaPeerPointBytes(), true).slice(1)
            )
            expect(ecdhSharedSecret).toBe(vector.ecdhSharedSecret)

            // Seed pipeline leg: deriveEddsaKeypair reproduces every downstream field.
            const keys = deriveEddsaKeypair(vector.ecdhSharedSecret)

            expect(keys.seed).toBe(vector.seed)
            expect(keys.secretScalar.toString(10)).toBe(vector.secretScalar)
            expect(keys.publicKey[0].toString(10)).toBe(vector.publicKey[0])
            expect(keys.publicKey[1].toString(10)).toBe(vector.publicKey[1])
            expect(keys.commitment.toString(10)).toBe(vector.commitment)
        }
    )
})
