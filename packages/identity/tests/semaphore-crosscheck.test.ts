/**
 * Cross-checks `deriveEddsaKeypair` against `@semaphore-protocol/identity` v4
 * directly — the interop contract of `DERIVATION.md` §12.5 — and pins the
 * raw-bytes-only seed contract (the §12.4 hex footgun).
 */

import { describe, it, expect } from "@jest/globals"
import { Identity } from "@semaphore-protocol/identity"
import { p256 } from "@noble/curves/p256"
import { deriveEddsaKeypair, derivePaymasterKeypair, eddsaPeerPointBytes } from "../src"
import type { Hex } from "../src/types"
import { bytesToHex, hexToBytes } from "../src/bytes"
import { seededP256Key } from "./helpers"
import vectorsDocument from "./vectors/eddsa-vectors.json"

interface Vector {
    ecdhSharedSecret: Hex
}

const { vectors } = vectorsDocument as unknown as { vectors: Vector[] }

const VECTOR_SECRETS: Hex[] = vectors.map((vector) => vector.ecdhSharedSecret)
// seededP256Key(0..11) are already in the vectors file; start past them.
const EXTRA_SECRETS: Hex[] = Array.from({ length: 8 }, (_unused, i) => {
    const { privateKey } = seededP256Key(i + 12)
    return bytesToHex(p256.getSharedSecret(privateKey, eddsaPeerPointBytes(), true).slice(1))
})
const SECRETS: Hex[] = [...VECTOR_SECRETS, ...EXTRA_SECRETS]

describe("Semaphore Identity cross-check", () => {
    it.each(SECRETS)("paymaster identity matches its published commitment for %s", (secret) => {
        const paymaster = derivePaymasterKeypair(secret)
        const holder = deriveEddsaKeypair(secret)
        const identity = new Identity(hexToBytes(paymaster.seed))

        expect(identity.commitment).toBe(paymaster.commitment)
        expect(identity.commitment).not.toBe(holder.commitment)
    })

    it.each(SECRETS)("agrees with @semaphore-protocol/identity for %s", (secret) => {
        const keys = deriveEddsaKeypair(secret)
        const id = new Identity(hexToBytes(keys.seed))

        expect(id.secretScalar).toBe(keys.secretScalar)
        expect(id.publicKey[0]).toBe(keys.publicKey[0])
        expect(id.publicKey[1]).toBe(keys.publicKey[1])
        expect(id.commitment).toBe(keys.commitment)
    })

    it.each(SECRETS)("hex-footgun regression: a hex-string seed derives a different commitment for %s", (secret) => {
        const keys = deriveEddsaKeypair(secret)

        const fromHexString = new Identity(keys.seed)
        expect(fromHexString.commitment).not.toBe(keys.commitment)

        // bare hex (no 0x) is still ASCII characters, not the raw bytes
        const fromBareHexString = new Identity(keys.seed.slice(2))
        expect(fromBareHexString.commitment).not.toBe(keys.commitment)
    })

    it.each(SECRETS)("export/import round-trips to the same commitment for %s", (secret) => {
        const keys = deriveEddsaKeypair(secret)
        const id = new Identity(hexToBytes(keys.seed))

        const reimported = Identity.import(id.export())
        expect(reimported.commitment).toBe(keys.commitment)
    })

    it.each(SECRETS)("Identity.verifySignature accepts a message signed with the derived identity for %s", (secret) => {
        const keys = deriveEddsaKeypair(secret)
        const id = new Identity(hexToBytes(keys.seed))

        // signMessage packs a string's UTF-8 bytes into 32 bytes — keep it short
        const message = "eddsa-crosscheck"
        const signature = id.signMessage(message)

        expect(Identity.verifySignature(message, signature, keys.publicKey)).toBe(true)
    })
})
