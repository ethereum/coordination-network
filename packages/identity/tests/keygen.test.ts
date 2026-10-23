/** Unit tests for the `v2` device key-derivation scheme — see `DERIVATION.md`. */

import { describe, it, expect } from "@jest/globals"
import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import {
    deriveKeys,
    deriveNetworkId,
    deriveAccountKeypair,
    signDerivationMessage,
    deriveStealthKeys,
    deriveAuthKeypair,
    computeNetworkId,
    computeMemberNetworkId,
    generateDeviceSecret,
    hashToScalar,
    hashToScalarWith,
    isValidScalar,
    scalarToKeypair,
    InvalidDeviceSecretError,
    DerivationFailureError,
    KeygenError,
    KEY_DERIVATION_VERSION,
    FIXED_DOMAIN_MSG,
    DOMAIN_ACCOUNT,
    DOMAIN_AUTH,
    DOMAIN_NETWORK_ID
} from "../src"
import type { Hex, Secp256k1Keypair } from "../src/types"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes, normalizeDeviceSecret } from "../src/bytes"
import { normalizeSignature64 } from "../src/account"
import * as constants from "../src/constants"
import { seededSecret, N } from "./helpers"

const SECRET_ONES = `0x${"01".repeat(32)}` as Hex
const SECRET_TWOS = `0x${"02".repeat(32)}` as Hex

describe("constants (frozen normative values)", () => {
    it("pins the exact literal values of every derivation constant", () => {
        expect(KEY_DERIVATION_VERSION).toBe("v2")
        expect(FIXED_DOMAIN_MSG).toBe("coordination-network/identity/v1")
        expect(DOMAIN_ACCOUNT).toBe("coordination-network/identity/v1/account")
        expect(DOMAIN_AUTH).toBe("coordination-network/identity/v1/auth")
        expect(DOMAIN_NETWORK_ID).toBe("coordination-network/identity/v2/network-id")
    })

    it("keeps the fixed domain message at its 32-byte UTF-8 length (EIP-191 length prefix)", () => {
        expect(utf8ToBytes(FIXED_DOMAIN_MSG)).toHaveLength(32)
    })
})

describe("domain tags", () => {
    // Tags are hashed as utf8(tag) || input with no length prefix; DOMAIN_EDDSA_PEER only feeds RFC 9380 hashToCurve.
    const tags = Object.entries(constants).flatMap(([name, value]) =>
        name.startsWith("DOMAIN_") && name !== "DOMAIN_EDDSA_PEER" && typeof value === "string" ? [value] : []
    )

    it("covers every keccak-prefixed tag", () => {
        expect(tags).toEqual(
            expect.arrayContaining([
                constants.DOMAIN_ACCOUNT,
                constants.DOMAIN_AUTH,
                constants.DOMAIN_EDDSA,
                constants.DOMAIN_NETWORK_ID
            ])
        )
    })

    it("has no tag that is a prefix of another", () => {
        const overlaps = tags.flatMap((a, i) => tags.filter((b, j) => i !== j && b.startsWith(a)).map((b) => [a, b]))
        expect(overlaps).toEqual([])
    })
})

describe("deriveKeys — determinism", () => {
    it("returns a deeply equal bundle for the same secret derived twice", () => {
        expect(deriveKeys(SECRET_ONES)).toEqual(deriveKeys(SECRET_ONES))
    })

    it("produces identical keys whether the secret is hex or the equivalent Uint8Array", () => {
        const fromHex = deriveKeys(SECRET_ONES)
        const fromBytes = deriveKeys(hexToBytes(SECRET_ONES))

        expect(fromBytes).toEqual(fromHex)
    })

    it("stamps the version field with the derivation-scheme version", () => {
        expect(deriveKeys(SECRET_ONES).version).toBe(KEY_DERIVATION_VERSION)
    })

    it("yields different networkIds and different keys for different secrets", () => {
        const a = deriveKeys(SECRET_ONES)
        const b = deriveKeys(SECRET_TWOS)

        expect(a.networkId).not.toBe(b.networkId)
        expect(a.account.privateKey).not.toBe(b.account.privateKey)
        expect(a.spending.privateKey).not.toBe(b.spending.privateKey)
        expect(a.viewing.privateKey).not.toBe(b.viewing.privateKey)
        expect(a.auth.privateKey).not.toBe(b.auth.privateKey)
    })

    it("is deterministic across a spread of seeded secrets", () => {
        for (let i = 0; i < 8; i += 1) {
            const secret = seededSecret(i)
            expect(deriveKeys(secret)).toEqual(deriveKeys(secret))
        }
    })
})

describe("deriveKeys — structural correctness", () => {
    const keys = deriveKeys(SECRET_ONES)
    const keypairs: [string, Secp256k1Keypair][] = [
        ["account", keys.account],
        ["spending", keys.spending],
        ["viewing", keys.viewing],
        ["auth", keys.auth]
    ]

    it.each(keypairs)("%s private key is a scalar in [1, n)", (_name, keypair) => {
        const scalar = BigInt(keypair.privateKey)
        expect(scalar).toBeGreaterThanOrEqual(1n)
        expect(scalar).toBeLessThan(N)
    })

    it.each(keypairs)("%s public keys parse and are internally consistent", (_name, keypair) => {
        expect(keypair.privateKey).toMatch(/^0x[0-9a-f]{64}$/)
        expect(keypair.publicKey).toMatch(/^0x02|^0x03/)
        expect(keypair.publicKey).toHaveLength(2 + 66)
        expect(keypair.uncompressedPublicKey).toMatch(/^0x04/)
        expect(keypair.uncompressedPublicKey).toHaveLength(2 + 130)

        // Both encodings decode to the same point, which equals getPublicKey(privateKey).
        const fromCompressed = secp256k1.ProjectivePoint.fromHex(keypair.publicKey.slice(2))
        const fromUncompressed = secp256k1.ProjectivePoint.fromHex(keypair.uncompressedPublicKey.slice(2))
        expect(fromCompressed.equals(fromUncompressed)).toBe(true)

        const expectedCompressed = bytesToHex(secp256k1.getPublicKey(hexToBytes(keypair.privateKey), true))
        const expectedUncompressed = bytesToHex(secp256k1.getPublicKey(hexToBytes(keypair.privateKey), false))
        expect(keypair.publicKey).toBe(expectedCompressed)
        expect(keypair.uncompressedPublicKey).toBe(expectedUncompressed)
    })

    it("produces four pairwise-distinct private keys", () => {
        const privs = keypairs.map(([, kp]) => kp.privateKey)
        expect(new Set(privs).size).toBe(4)
    })
})

describe("networkId invariant", () => {
    const keys = deriveKeys(SECRET_ONES)
    const coordinates = hexToBytes(keys.account.uncompressedPublicKey).slice(1) // drop 0x04

    it("equals keccak256(utf8(DOMAIN_NETWORK_ID) || X || Y), computed independently", () => {
        const expected = bytesToHex(keccak_256(concatBytes(utf8ToBytes(DOMAIN_NETWORK_ID), coordinates)))
        expect(keys.networkId).toBe(expected)
    })

    it("does not expose the account's Ethereum address in its low 20 bytes", () => {
        const address = bytesToHex(keccak_256(coordinates).slice(-20))
        expect(keys.networkId.slice(-40)).not.toBe(address.slice(2))
    })

    it("matches the cheap deriveNetworkId path exactly", () => {
        for (let i = 0; i < 6; i += 1) {
            const secret = seededSecret(i)
            expect(deriveNetworkId(secret)).toBe(deriveKeys(secret).networkId)
        }
    })
})

describe("memberNetworkId invariant", () => {
    const keys = deriveKeys(SECRET_ONES)
    const coordinates = hexToBytes(keys.account.uncompressedPublicKey).slice(1) // drop 0x04

    it("equals keccak256 of the 64-byte raw X || Y coordinates", () => {
        expect(keys.memberNetworkId).toBe(bytesToHex(keccak_256(coordinates)))
    })

    it("has its last 20 bytes equal to the account's Ethereum address (computed independently)", () => {
        const address = bytesToHex(keccak_256(coordinates).slice(-20))
        expect(keys.memberNetworkId.slice(-40)).toBe(address.slice(2))
    })

    it("differs from the user networkId", () => {
        expect(keys.memberNetworkId).not.toBe(keys.networkId)
    })
})

describe("device secret validation (negative tests)", () => {
    const bad: [string, unknown][] = [
        ["31-byte Uint8Array", new Uint8Array(31)],
        ["33-byte Uint8Array", new Uint8Array(33)],
        ["empty Uint8Array", new Uint8Array(0)],
        ["empty string", ""],
        ["31-byte hex (62 chars)", `0x${"01".repeat(31)}`],
        ["33-byte hex (66 chars)", `0x${"01".repeat(33)}`],
        ["odd-length hex", `0x${"0".repeat(63)}`],
        ["missing 0x prefix", "01".repeat(32)],
        ["non-hex characters", `0x${"z".repeat(64)}`],
        ["a number", 123],
        ["null", null],
        ["undefined", undefined]
    ]

    it.each(bad)("rejects %s with InvalidDeviceSecretError (code INVALID_DEVICE_SECRET)", (_name, value) => {
        expect(() => deriveKeys(value as Hex)).toThrow(InvalidDeviceSecretError)

        let caught: unknown
        try {
            deriveKeys(value as Hex)
        } catch (error) {
            caught = error
        }
        expect(caught).toBeInstanceOf(KeygenError)
        expect((caught as KeygenError).code).toBe("INVALID_DEVICE_SECRET")
    })

    it("accepts a valid 32-byte Uint8Array and a valid 64-hex-char string", () => {
        expect(() => deriveKeys(new Uint8Array(32).fill(1))).not.toThrow()
        expect(() => deriveKeys(SECRET_ONES)).not.toThrow()
    })

    it("normalizeDeviceSecret returns a 32-byte defensive copy", () => {
        const input = new Uint8Array(32).fill(7)
        const out = normalizeDeviceSecret(input)
        expect(out).toHaveLength(32)
        expect(out).not.toBe(input)
        out[0] = 0
        expect(input[0]).toBe(7)
    })
})

describe("generateDeviceSecret", () => {
    it("returns a 0x-prefixed 32-byte hex string", () => {
        const secret = generateDeviceSecret()
        expect(secret).toMatch(/^0x[0-9a-f]{64}$/)
        expect(hexToBytes(secret)).toHaveLength(32)
    })

    it("is a valid device secret that feeds deriveKeys", () => {
        expect(() => deriveKeys(generateDeviceSecret())).not.toThrow()
    })

    it("differs across calls (fresh randomness)", () => {
        const seen = new Set<string>()
        for (let i = 0; i < 32; i += 1) {
            seen.add(generateDeviceSecret())
        }
        expect(seen.size).toBe(32)
    })

    it("throws a KeygenError when no secure RNG is available", () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")

        try {
            Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true })
            expect(() => generateDeviceSecret()).toThrow(KeygenError)

            let caught: unknown
            try {
                generateDeviceSecret()
            } catch (error) {
                caught = error
            }
            expect((caught as KeygenError).code).toBe("DERIVATION_FAILURE")
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "crypto", original)
            }
        }
    })

    it("throws when crypto exists but lacks getRandomValues", () => {
        const original = Object.getOwnPropertyDescriptor(globalThis, "crypto")

        try {
            Object.defineProperty(globalThis, "crypto", { value: {}, configurable: true })
            expect(() => generateDeviceSecret()).toThrow(KeygenError)
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "crypto", original)
            }
        }
    })
})

describe("hashToScalar", () => {
    it("produces an in-range scalar and matches the keccak_256 default primitive", () => {
        const input = new Uint8Array(32).fill(9)
        const scalar = hashToScalar(DOMAIN_ACCOUNT, input)

        expect(scalar).toHaveLength(32)
        expect(isValidScalar(scalar)).toBe(true)
        expect(hashToScalar(DOMAIN_ACCOUNT, input)).toEqual(scalar)
    })

    it("takes the reject/retry (counter increment) branch when the first candidate is >= n", () => {
        const outOfRange = new Uint8Array(32).fill(0xff) // 2^256 - 1, which is >= n
        const valid = new Uint8Array(32)
        valid[31] = 42

        let calls = 0
        const stubHash = (input: Uint8Array): Uint8Array => {
            calls += 1
            // The last byte of `input` is the counter; assert it advances.
            expect(input[input.length - 1]).toBe(calls - 1)
            return calls === 1 ? outOfRange : valid
        }

        const scalar = hashToScalarWith(stubHash, "tag", new Uint8Array([1, 2, 3]))
        expect(calls).toBe(2)
        expect(scalar).toEqual(valid)
    })

    it("also rejects a zero candidate before accepting a valid one", () => {
        const zero = new Uint8Array(32) // value 0, out of [1, n)
        const valid = new Uint8Array(32)
        valid[31] = 1

        let calls = 0
        const stubHash = (): Uint8Array => {
            calls += 1
            return calls === 1 ? zero : valid
        }

        expect(hashToScalarWith(stubHash, "tag", new Uint8Array())).toEqual(valid)
        expect(calls).toBe(2)
    })

    it("throws DerivationFailureError when all 256 counters are exhausted", () => {
        const alwaysOutOfRange = new Uint8Array(32).fill(0xff)
        const stubHash = (): Uint8Array => alwaysOutOfRange

        expect(() => hashToScalarWith(stubHash, "tag", new Uint8Array())).toThrow(DerivationFailureError)
    })
})

describe("error defaults", () => {
    it("DerivationFailureError exposes a default message and DERIVATION_FAILURE code", () => {
        const err = new DerivationFailureError()
        expect(err).toBeInstanceOf(KeygenError)
        expect(err.code).toBe("DERIVATION_FAILURE")
        expect(err.name).toBe("DerivationFailureError")
        expect(err.message).toBe("Key derivation failed")
    })
})

describe("isValidScalar / scalarToKeypair", () => {
    it("accepts a scalar in [1, n) and rejects out-of-range or wrong-length scalars", () => {
        const one = new Uint8Array(32)
        one[31] = 1
        expect(isValidScalar(one)).toBe(true)

        expect(isValidScalar(new Uint8Array(32))).toBe(false) // zero
        expect(isValidScalar(new Uint8Array(32).fill(0xff))).toBe(false) // >= n
        expect(isValidScalar(new Uint8Array(31))).toBe(false) // wrong length
        expect(isValidScalar(new Uint8Array(33))).toBe(false) // wrong length

        // Exactly n is out of range.
        expect(isValidScalar(hexToBytes(`0x${N.toString(16).padStart(64, "0")}`))).toBe(false)
    })

    it("scalarToKeypair throws DerivationFailureError on an invalid scalar", () => {
        expect(() => scalarToKeypair(new Uint8Array(32))).toThrow(DerivationFailureError)
        expect(() => scalarToKeypair(new Uint8Array(31))).toThrow(DerivationFailureError)
    })

    it("scalarToKeypair round-trips a valid scalar through noble", () => {
        const scalar = new Uint8Array(32)
        scalar[31] = 5
        const keypair = scalarToKeypair(scalar)
        expect(keypair.privateKey).toBe(bytesToHex(scalar))
        expect(keypair.publicKey).toBe(bytesToHex(secp256k1.getPublicKey(scalar, true)))
    })
})

describe("computeNetworkId", () => {
    const keys = deriveKeys(SECRET_ONES)
    const uncompressed = hexToBytes(keys.account.uncompressedPublicKey)

    it("accepts the 65-byte 0x04-prefixed form and the 64-byte raw form identically", () => {
        const fromPrefixed = computeNetworkId(keys.account.uncompressedPublicKey)
        const fromRaw = computeNetworkId(uncompressed.slice(1))
        expect(fromPrefixed).toBe(fromRaw)
        expect(fromPrefixed).toBe(keys.networkId)
    })

    it("accepts raw bytes and hex equivalently", () => {
        expect(computeNetworkId(uncompressed)).toBe(computeNetworkId(keys.account.uncompressedPublicKey))
    })

    it("rejects a wrong-length key with a TypeError", () => {
        expect(() => computeNetworkId(new Uint8Array(63))).toThrow(TypeError)
        expect(() => computeNetworkId(new Uint8Array(66))).toThrow(TypeError)
    })

    it("rejects a 65-byte key whose prefix is not 0x04", () => {
        const bad = uncompressed.slice()
        bad[0] = 0x03
        expect(() => computeNetworkId(bad)).toThrow(TypeError)
    })
})

describe("computeMemberNetworkId", () => {
    const keys = deriveKeys(SECRET_ONES)
    const uncompressed = hexToBytes(keys.account.uncompressedPublicKey)

    it("accepts the 65-byte 0x04-prefixed form and the 64-byte raw form identically", () => {
        expect(computeMemberNetworkId(uncompressed.slice(1))).toBe(computeMemberNetworkId(uncompressed))
        expect(computeMemberNetworkId(uncompressed)).toBe(keys.memberNetworkId)
    })

    it("rejects a wrong-length key with a TypeError", () => {
        expect(() => computeMemberNetworkId(new Uint8Array(63))).toThrow(TypeError)
    })

    it("rejects a 65-byte key whose prefix is not 0x04", () => {
        const bad = uncompressed.slice()
        bad[0] = 0x03
        expect(() => computeMemberNetworkId(bad)).toThrow(TypeError)
    })

    it("accepts hex and raw bytes identically", () => {
        expect(computeMemberNetworkId(keys.account.uncompressedPublicKey)).toBe(computeMemberNetworkId(uncompressed))
    })
})

describe("network id error messages", () => {
    it.each([
        ["computeNetworkId", computeNetworkId],
        ["computeMemberNetworkId", computeMemberNetworkId]
    ])("%s names itself and the accepted key forms", (name, fn) => {
        expect(() => fn(new Uint8Array(33))).toThrow(`${name}: expected a 65-byte 0x04-prefixed or 64-byte raw`)
    })
})

describe("deriveNetworkId", () => {
    it("is the user networkId, not the member id", () => {
        const secret = seededSecret(3)
        const keys = deriveKeys(secret)
        expect(deriveNetworkId(secret)).toBe(keys.networkId)
        expect(deriveNetworkId(secret)).not.toBe(keys.memberNetworkId)
    })
})

describe("signDerivationMessage / normalizeSignature64", () => {
    const account = deriveAccountKeypair(SECRET_ONES)

    it("is deterministic and 64 bytes, independent of hex vs bytes input", () => {
        const fromHex = signDerivationMessage(account.privateKey)
        const fromBytes = signDerivationMessage(hexToBytes(account.privateKey))
        expect(fromHex).toBe(fromBytes)
        expect(fromHex).toMatch(/^0x[0-9a-f]{128}$/)
        expect(signDerivationMessage(account.privateKey)).toBe(fromHex)
    })

    it("normalizeSignature64 accepts 64-byte hex and bytes, rejects other lengths", () => {
        const sig = signDerivationMessage(account.privateKey)
        expect(normalizeSignature64(sig)).toEqual(hexToBytes(sig))
        expect(normalizeSignature64(hexToBytes(sig))).toEqual(hexToBytes(sig))
        expect(() => normalizeSignature64(`0x${"00".repeat(63)}` as Hex)).toThrow(TypeError)
        expect(() => normalizeSignature64(new Uint8Array(65))).toThrow(TypeError)
    })

    it("stealth and auth derivation reject malformed signatures with a TypeError", () => {
        expect(() => deriveStealthKeys(`0x${"00".repeat(10)}` as Hex)).toThrow(TypeError)
        expect(() => deriveAuthKeypair(new Uint8Array(63))).toThrow(TypeError)
    })
})

describe("step derivation matches the deriveKeys pipeline", () => {
    it("account/spending/viewing/auth agree with the orchestrated bundle", () => {
        const secret = seededSecret(3)
        const keys = deriveKeys(secret)

        const account = deriveAccountKeypair(secret)
        const sig = signDerivationMessage(account.privateKey)
        const { spending, viewing } = deriveStealthKeys(sig)
        const auth = deriveAuthKeypair(sig)

        expect(account).toEqual(keys.account)
        expect(spending).toEqual(keys.spending)
        expect(viewing).toEqual(keys.viewing)
        expect(auth).toEqual(keys.auth)
        expect(computeNetworkId(account.uncompressedPublicKey)).toBe(keys.networkId)
    })

    it("stealth keys equal keccak256 of the two signature halves (FluidKey semantics)", () => {
        const account = deriveAccountKeypair(SECRET_ONES)
        const sig = hexToBytes(signDerivationMessage(account.privateKey))
        const { spending, viewing } = deriveStealthKeys(sig)

        expect(spending.privateKey).toBe(bytesToHex(keccak_256(sig.slice(0, 32))))
        expect(viewing.privateKey).toBe(bytesToHex(keccak_256(sig.slice(32, 64))))
    })

    it("auth key equals hashToScalar(DOMAIN_AUTH, sig)", () => {
        const account = deriveAccountKeypair(SECRET_ONES)
        const sig = hexToBytes(signDerivationMessage(account.privateKey))
        const auth = deriveAuthKeypair(sig)
        expect(auth.privateKey).toBe(bytesToHex(hashToScalar(DOMAIN_AUTH, sig)))
    })

    it("account key equals hashToScalar(DOMAIN_ACCOUNT, deviceSecret)", () => {
        const account = deriveAccountKeypair(SECRET_ONES)
        expect(account.privateKey).toBe(bytesToHex(hashToScalar(DOMAIN_ACCOUNT, hexToBytes(SECRET_ONES))))
    })
})

describe("bytes utilities", () => {
    it("hexToBytes rejects a non-string, a missing prefix, odd length, and non-hex", () => {
        expect(() => hexToBytes(123 as unknown as string)).toThrow(TypeError)
        expect(() => hexToBytes("00")).toThrow(TypeError)
        expect(() => hexToBytes("0x0")).toThrow(TypeError)
        expect(() => hexToBytes("0xzz")).toThrow(TypeError)
    })

    it("hexToBytes/bytesToHex round-trip", () => {
        const bytes = new Uint8Array([0, 1, 15, 16, 255])
        expect(hexToBytes(bytesToHex(bytes))).toEqual(bytes)
        expect(bytesToHex(new Uint8Array())).toBe("0x")
    })

    it("concatBytes joins arrays in order", () => {
        expect(concatBytes(new Uint8Array([1, 2]), new Uint8Array(), new Uint8Array([3]))).toEqual(
            new Uint8Array([1, 2, 3])
        )
    })

    it("utf8ToBytes encodes UTF-8", () => {
        expect(utf8ToBytes("ab")).toEqual(new Uint8Array([0x61, 0x62]))
    })
})
