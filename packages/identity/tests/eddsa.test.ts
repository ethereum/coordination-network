/** Unit tests for the Baby Jubjub EdDSA fifth-key derivation (`src/eddsa.ts`). */

import { describe, it, expect } from "@jest/globals"
import { p256 } from "@noble/curves/p256"
import { keccak_256 } from "@noble/hashes/sha3"
import { poseidon2 } from "poseidon-lite/poseidon2"
import {
    deriveEddsaKeypair,
    derivePaymasterKeypair,
    deriveKeys,
    eddsaPeerPointBytes,
    normalizeEcdhSharedSecret,
    InvalidEcdhSecretError,
    KeygenError,
    DOMAIN_EDDSA,
    DOMAIN_PAYMASTER
} from "../src"
import type { DerivedKeys, Hex } from "../src/types"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "../src/bytes"
import { seededSecret, seededP256Key } from "./helpers"

/** Software ECDH stand-in for the hardware `hwPriv · Q` agreement. */
function sharedSecret(index: number): Hex {
    const { privateKey } = seededP256Key(index)
    return bytesToHex(p256.getSharedSecret(privateKey, eddsaPeerPointBytes(), true).slice(1))
}

const SS_KEY0 = sharedSecret(0)
const SS_KEY1 = sharedSecret(1)

/** Asserts a four-key secp256k1 set shares no value with the eddsa key material or `extraValue`. */
function expectDisjointFromEddsa(
    fourKeys: DerivedKeys,
    eddsaSeed: Hex,
    eddsaSecretScalar: bigint,
    extraValue: string
): void {
    const values = new Set<string>([
        fourKeys.account.privateKey,
        fourKeys.spending.privateKey,
        fourKeys.viewing.privateKey,
        fourKeys.auth.privateKey,
        eddsaSeed,
        extraValue
    ])
    expect(values.size).toBe(6)

    const scalars = [
        BigInt(fourKeys.account.privateKey),
        BigInt(fourKeys.spending.privateKey),
        BigInt(fourKeys.viewing.privateKey),
        BigInt(fourKeys.auth.privateKey)
    ]
    for (const scalar of scalars) {
        expect(eddsaSecretScalar).not.toBe(scalar)
    }
}

describe("deriveEddsaKeypair — determinism", () => {
    it("returns a deeply equal keypair for the same shared secret derived twice", () => {
        expect(deriveEddsaKeypair(SS_KEY0)).toEqual(deriveEddsaKeypair(SS_KEY0))
    })

    it("produces identical keys whether the shared secret is hex or the equivalent Uint8Array", () => {
        const fromHex = deriveEddsaKeypair(SS_KEY0)
        const fromBytes = deriveEddsaKeypair(hexToBytes(SS_KEY0))

        expect(fromBytes).toEqual(fromHex)
    })

    it("is deterministic across a spread of seeded hardware keys", () => {
        for (let i = 0; i < 8; i += 1) {
            const ss = sharedSecret(i)
            expect(deriveEddsaKeypair(ss)).toEqual(deriveEddsaKeypair(ss))
        }
    })
})

describe("deriveEddsaKeypair — seed-formula known-answer test", () => {
    it("matches an independently recomputed keccak256(utf8(DOMAIN_EDDSA) || ecdhSharedSecret)", () => {
        const keys = deriveEddsaKeypair(SS_KEY0)
        const expectedSeed = keccak_256(concatBytes(utf8ToBytes(DOMAIN_EDDSA), hexToBytes(SS_KEY0)))

        expect(keys.seed).toBe(bytesToHex(expectedSeed))
    })

    it("holds for a spread of seeded hardware keys, not just one fixed value", () => {
        for (let i = 0; i < 6; i += 1) {
            const ss = sharedSecret(i)
            const keys = deriveEddsaKeypair(ss)
            const expectedSeed = keccak_256(concatBytes(utf8ToBytes(DOMAIN_EDDSA), hexToBytes(ss)))

            expect(keys.seed).toBe(bytesToHex(expectedSeed))
        }
    })

    // Pinned literals, not recomputed — a KAT against the committed vector-0.
    it("matches the literal vector-0 KAT from tests/vectors/eddsa-vectors.json", () => {
        const hardwarePrivateKey = "0x04c24e28137645245958ac3e6e50d1d8c828f2a810eb4c977b836f5aeae0e61f" as Hex
        const expectedEcdhSharedSecret = "0xc3c8522e76f3316bd449133621ba4f00a9e8cfbc5fd1b1a6a21c3c0c2c83e93a" as Hex
        const expectedSeed = "0x68391587b7b63f3722ef20c50368ea89a3538c5fdb01022be1838833fc587d64" as Hex

        const ecdhSharedSecret = bytesToHex(
            p256.getSharedSecret(hexToBytes(hardwarePrivateKey), eddsaPeerPointBytes(), true).slice(1)
        )
        expect(ecdhSharedSecret).toBe(expectedEcdhSharedSecret)

        const keys = deriveEddsaKeypair(ecdhSharedSecret)
        expect(keys.seed).toBe(expectedSeed)
    })
})

describe("deriveEddsaKeypair — commitment", () => {
    it("equals poseidon2(publicKey) recomputed independently", () => {
        const keys = deriveEddsaKeypair(SS_KEY0)
        expect(keys.commitment).toBe(poseidon2(keys.publicKey))
    })

    it("holds across a spread of seeded hardware keys", () => {
        for (let i = 0; i < 6; i += 1) {
            const keys = deriveEddsaKeypair(sharedSecret(i))
            expect(keys.commitment).toBe(poseidon2(keys.publicKey))
        }
    })
})

describe("deriveEddsaKeypair — distinctness", () => {
    it("never publishes the credential holder commitment as the paymaster leaf", () => {
        for (let i = 0; i < 8; i += 1) {
            const secret = sharedSecret(i)
            const holder = deriveEddsaKeypair(secret)
            const paymaster = derivePaymasterKeypair(secret)
            const expectedSeed = keccak_256(concatBytes(utf8ToBytes(DOMAIN_PAYMASTER), hexToBytes(secret)))

            expect(paymaster.seed).toBe(bytesToHex(expectedSeed))
            expect(paymaster.seed).not.toBe(holder.seed)
            expect(paymaster.publicKey).not.toEqual(holder.publicKey)
            expect(paymaster.commitment).not.toBe(holder.commitment)
            expect(derivePaymasterKeypair(secret)).toEqual(paymaster)
        }
    })

    it("different shared secrets yield different commitments (and seeds, and scalars)", () => {
        const a = deriveEddsaKeypair(SS_KEY0)
        const b = deriveEddsaKeypair(SS_KEY1)

        expect(a.commitment).not.toBe(b.commitment)
        expect(a.seed).not.toBe(b.seed)
        expect(a.secretScalar).not.toBe(b.secretScalar)
        expect(a.publicKey).not.toEqual(b.publicKey)
    })

    it("the fifth key is pairwise-distinct from the four-key secp256k1 model derived from an unrelated device secret", () => {
        for (let i = 0; i < 8; i += 1) {
            const secret = seededSecret(i)
            const keys = deriveKeys(secret)
            const ss = sharedSecret(i)
            const eddsa = deriveEddsaKeypair(ss)

            expectDisjointFromEddsa(keys, eddsa.seed, eddsa.secretScalar, secret)

            // Domain-separation leg: feed the ECDH shared secret that produced `eddsa`
            // into deriveKeys as if it were an ordinary device secret — the two domains
            // must not collide even on shared input.
            const sameInputKeys = deriveKeys(ss)
            expectDisjointFromEddsa(sameInputKeys, eddsa.seed, eddsa.secretScalar, ss)
        }
    })
})

describe("deriveEddsaKeypair — ECDH shared secret validation", () => {
    it("rejects a 31-byte shared secret with InvalidEcdhSecretError", () => {
        expect(() => deriveEddsaKeypair(new Uint8Array(31))).toThrow(InvalidEcdhSecretError)

        let caught: unknown
        try {
            deriveEddsaKeypair(new Uint8Array(31))
        } catch (error) {
            caught = error
        }
        expect(caught).toBeInstanceOf(KeygenError)
        expect((caught as KeygenError).code).toBe("INVALID_ECDH_SECRET")
    })

    it("rejects a 33-byte shared secret with InvalidEcdhSecretError", () => {
        expect(() => deriveEddsaKeypair(new Uint8Array(33))).toThrow(InvalidEcdhSecretError)
    })

    it("rejects a 33-byte hex shared secret with InvalidEcdhSecretError", () => {
        expect(() => deriveEddsaKeypair(`0x${"01".repeat(33)}` as Hex)).toThrow(InvalidEcdhSecretError)
    })
})

describe("normalizeEcdhSharedSecret", () => {
    it("returns a 32-byte defensive copy for a Uint8Array input", () => {
        const input = new Uint8Array(32).fill(7)
        const out = normalizeEcdhSharedSecret(input)

        expect(out).toHaveLength(32)
        expect(out).not.toBe(input)
        expect(out).toEqual(input)

        out[0] = 0
        expect(input[0]).toBe(7)
    })

    it("round-trips a 0x-prefixed 64-hex-char string", () => {
        const hex = `0x${"ab".repeat(32)}` as Hex
        const out = normalizeEcdhSharedSecret(hex)

        expect(bytesToHex(out)).toBe(hex)
    })

    it("throws InvalidEcdhSecretError directly for a bad input", () => {
        expect(() => normalizeEcdhSharedSecret(new Uint8Array(31))).toThrow(InvalidEcdhSecretError)
    })

    it("rethrows a failure that is not an invalid-secret error unchanged", () => {
        const failure = new Error("length unreadable")
        class Unreadable extends Uint8Array {
            override get length(): number {
                throw failure
            }
        }

        expect(() => normalizeEcdhSharedSecret(new Unreadable(32))).toThrow(failure)
    })
})
