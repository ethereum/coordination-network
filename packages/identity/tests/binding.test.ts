/**
 * Unit tests for the credential dual proof-of-possession binding module
 * (`src/binding.ts`, `src/confirmation-key.ts`) — see `DERIVATION.md` §11.
 */

import { describe, it, expect } from "@jest/globals"
import { secp256k1 } from "@noble/curves/secp256k1"
import { p256 } from "@noble/curves/p256"
import { keccak_256 } from "@noble/hashes/sha3"
import { sha256 } from "@noble/hashes/sha2"
import {
    deriveKeys,
    deriveAccountKeypair,
    computeNetworkId,
    normalizeConfirmationKey,
    computeConfirmationKeyHash,
    buildDeviceBindingMessage,
    buildAccountBindingMessage,
    buildBindingMessages,
    signAccountBinding,
    verifyAccountBindingSignature,
    verifyDeviceBindingSignature,
    verifyCredentialBinding,
    InvalidBindingInputError,
    KeygenError,
    BINDING_NONCE_LENGTH
} from "../src"
import type { Hex } from "../src/types"
import { bytesToBase64url, bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "../src/bytes"
import { seededSecret, seededNonce, seededP256Key, seededCommitment, N, P256_N } from "./helpers"

const SECRET_ONES = `0x${"01".repeat(32)}` as Hex
const SECRET_TWOS = `0x${"02".repeat(32)}` as Hex
const HOLDER = seededCommitment("holder", 0)
const REQUEST = seededCommitment("request", 0)
const OTHER_REQUEST = seededCommitment("request", 1)
const COMMITMENTS = { holderKeyCommitment: HOLDER, requestCommitment: REQUEST }

/** Rebuilds the EIP-191 personal-sign digest exactly as `binding.ts` does. */
function eip191Digest(message: Uint8Array): Uint8Array {
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${String(message.length)}`)
    return keccak_256(concatBytes(prefix, message))
}

function expectInvalidBindingInput(fn: () => void): void {
    expect(fn).toThrow(InvalidBindingInputError)

    let caught: unknown
    try {
        fn()
    } catch (error) {
        caught = error
    }
    expect(caught).toBeInstanceOf(KeygenError)
    expect((caught as KeygenError).code).toBe("INVALID_BINDING_INPUT")
}

describe("BINDING_NONCE_LENGTH", () => {
    it("is exactly 32", () => {
        expect(BINDING_NONCE_LENGTH).toBe(32)
    })
})

describe("error defaults", () => {
    it("InvalidBindingInputError exposes a default message and INVALID_BINDING_INPUT code", () => {
        const err = new InvalidBindingInputError()
        expect(err).toBeInstanceOf(KeygenError)
        expect(err.code).toBe("INVALID_BINDING_INPUT")
        expect(err.name).toBe("InvalidBindingInputError")
        expect(err.message).toBe("Invalid credential-binding input")
    })
})

describe("buildDeviceBindingMessage", () => {
    it("is byte-exact nonce || networkId || holderKeyCommitment || requestCommitment, 128 bytes total", () => {
        const nonce = seededNonce(0)
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)

        const message = buildDeviceBindingMessage(nonce, networkId, HOLDER, REQUEST)

        expect(message).toHaveLength(128)
        expect(message.slice(0, 32)).toEqual(nonce)
        expect(message.slice(32, 64)).toEqual(networkId)
        expect(message.slice(64, 96)).toEqual(HOLDER)
        expect(message.slice(96, 128)).toEqual(REQUEST)
        expect(message).toEqual(concatBytes(nonce, networkId, HOLDER, REQUEST))
    })

    it("accepts hex and Uint8Array equivalently", () => {
        const nonce = seededNonce(1)
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)

        const fromBytes = buildDeviceBindingMessage(nonce, networkId, HOLDER, REQUEST)
        const fromHex = buildDeviceBindingMessage(
            bytesToHex(nonce),
            bytesToHex(networkId),
            bytesToHex(HOLDER),
            bytesToHex(REQUEST)
        )

        expect(fromHex).toEqual(fromBytes)
    })

    it.each([
        ["31-byte nonce", new Uint8Array(31), new Uint8Array(32)],
        ["33-byte nonce", new Uint8Array(33), new Uint8Array(32)],
        ["31-byte networkId", new Uint8Array(32), new Uint8Array(31)],
        ["33-byte networkId", new Uint8Array(32), new Uint8Array(33)]
    ])("rejects %s with InvalidBindingInputError", (_name, nonce, networkId) => {
        const fn = () => buildDeviceBindingMessage(nonce, networkId, HOLDER, REQUEST)
        expectInvalidBindingInput(fn)
    })

    it.each([
        ["holderKeyCommitment", 31],
        ["holderKeyCommitment", 33],
        ["requestCommitment", 31],
        ["requestCommitment", 33]
    ])("rejects a %s of %i bytes with InvalidBindingInputError", (name, length) => {
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)
        const wrong = new Uint8Array(length)
        const fn = () =>
            name === "holderKeyCommitment"
                ? buildDeviceBindingMessage(seededNonce(0), networkId, wrong, REQUEST)
                : buildDeviceBindingMessage(seededNonce(0), networkId, HOLDER, wrong)
        expectInvalidBindingInput(fn)
    })

    it("requires both commitments", () => {
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)
        // @ts-expect-error requestCommitment is required
        expectInvalidBindingInput(() => buildDeviceBindingMessage(seededNonce(0), networkId, HOLDER))
        // @ts-expect-error holderKeyCommitment and requestCommitment are required
        expectInvalidBindingInput(() => buildDeviceBindingMessage(seededNonce(0), networkId))
    })

    it("changes the message when requestCommitment changes", () => {
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)
        expect(buildDeviceBindingMessage(seededNonce(0), networkId, HOLDER, REQUEST)).not.toEqual(
            buildDeviceBindingMessage(seededNonce(0), networkId, HOLDER, OTHER_REQUEST)
        )
    })

    it("rejects a malformed hex-string nonce with InvalidBindingInputError, not a raw TypeError", () => {
        const networkId = deriveKeys(SECRET_ONES).networkId
        expectInvalidBindingInput(() => buildDeviceBindingMessage("0xzz", networkId, HOLDER, REQUEST))
        expectInvalidBindingInput(() => buildDeviceBindingMessage(`0x${"00".repeat(31)}0`, networkId, HOLDER, REQUEST))
    })
})

describe("normalizeConfirmationKey / computeConfirmationKeyHash", () => {
    const { privateKey: priv, publicKey: uncompressed65 } = seededP256Key(0) // 0x04 prefix
    const compressed33 = p256.getPublicKey(priv, true)
    const raw64 = uncompressed65.slice(1) // no prefix

    it("normalizes all three encodings to the identical 64-byte raw X || Y", () => {
        const fromUncompressed = normalizeConfirmationKey(uncompressed65)
        const fromCompressed = normalizeConfirmationKey(compressed33)
        const fromRaw = normalizeConfirmationKey(raw64)

        expect(fromUncompressed).toHaveLength(64)
        expect(fromCompressed).toEqual(fromUncompressed)
        expect(fromRaw).toEqual(fromUncompressed)
        expect(fromUncompressed).toEqual(raw64)
    })

    it("accepts hex and Uint8Array equivalently for every encoding", () => {
        expect(normalizeConfirmationKey(bytesToHex(uncompressed65))).toEqual(normalizeConfirmationKey(uncompressed65))
        expect(normalizeConfirmationKey(bytesToHex(compressed33))).toEqual(normalizeConfirmationKey(compressed33))
        expect(normalizeConfirmationKey(bytesToHex(raw64))).toEqual(normalizeConfirmationKey(raw64))
    })

    it("computeConfirmationKeyHash equals the RFC 7638 JWK thumbprint for every encoding", () => {
        const x = bytesToBase64url(raw64.slice(0, 32))
        const y = bytesToBase64url(raw64.slice(32))
        const expected = bytesToHex(sha256(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`))

        expect(computeConfirmationKeyHash(uncompressed65)).toBe(expected)
        expect(computeConfirmationKeyHash(compressed33)).toBe(expected)
        expect(computeConfirmationKeyHash(raw64)).toBe(expected)
    })

    it("matches the credential layer's jwkThumbprint byte for byte", () => {
        // The two packages must agree or a wallet cannot get a credential
        // issued: credential holds the key as a JWK, identity as raw SEC1.
        const jwk = {
            crv: "P-256",
            kty: "EC",
            x: bytesToBase64url(raw64.slice(0, 32)),
            y: bytesToBase64url(raw64.slice(32))
        }
        const credentialSide = sha256(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }))

        expect(computeConfirmationKeyHash(raw64)).toBe(bytesToHex(credentialSide))
    })

    it("rejects a wrong-length key with InvalidBindingInputError", () => {
        const tooShort = () => normalizeConfirmationKey(new Uint8Array(63))
        expectInvalidBindingInput(tooShort)
        expectInvalidBindingInput(() => normalizeConfirmationKey(new Uint8Array(66)))
        expectInvalidBindingInput(() => normalizeConfirmationKey(new Uint8Array(0)))
    })

    it("rejects an off-curve 65-byte point with InvalidBindingInputError", () => {
        const offCurve = uncompressed65.slice()
        offCurve[64] ^= 0xff // flip a byte of Y so (X, Y) is no longer on the curve
        const fn = () => normalizeConfirmationKey(offCurve)
        expectInvalidBindingInput(fn)
    })

    it("rejects a malformed hex string with InvalidBindingInputError, not a raw TypeError", () => {
        expectInvalidBindingInput(() => normalizeConfirmationKey("0xzz"))
        expectInvalidBindingInput(() => computeConfirmationKeyHash(`0x${"ab".repeat(32)}a`))
    })

    it("rejects a 64-byte raw key whose coordinates are off-curve", () => {
        const offCurve = raw64.slice()
        offCurve[63] ^= 0xff
        const fn = () => normalizeConfirmationKey(offCurve)
        expectInvalidBindingInput(fn)
    })
})

describe("buildAccountBindingMessage", () => {
    const { privateKey: priv, publicKey: confirmationKey } = seededP256Key(1)

    it("is byte-exact nonce(32) || confirmationKeyHash(32) || networkId(32), 96 bytes total", () => {
        const nonce = seededNonce(2)
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)
        const expectedHash = hexToBytes(computeConfirmationKeyHash(confirmationKey))

        const message = buildAccountBindingMessage(nonce, confirmationKey, networkId)

        expect(message).toHaveLength(96)
        expect(message.slice(0, 32)).toEqual(nonce)
        expect(message.slice(32, 64)).toEqual(expectedHash)
        expect(message.slice(64, 96)).toEqual(networkId)
        expect(message).toEqual(concatBytes(nonce, expectedHash, networkId))
    })

    it("produces the identical message for every confirmationKey encoding", () => {
        const nonce = seededNonce(3)
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)
        const raw64 = confirmationKey.slice(1)
        const compressed = p256.getPublicKey(priv, true)

        const a = buildAccountBindingMessage(nonce, confirmationKey, networkId)
        const b = buildAccountBindingMessage(nonce, raw64, networkId)
        const c = buildAccountBindingMessage(nonce, compressed, networkId)

        expect(b).toEqual(a)
        expect(c).toEqual(a)
    })

    it("rejects a malformed nonce/networkId/confirmationKey with InvalidBindingInputError", () => {
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)

        const badNonce = () => buildAccountBindingMessage(new Uint8Array(31), confirmationKey, networkId)
        expectInvalidBindingInput(badNonce)
        expectInvalidBindingInput(() => buildAccountBindingMessage(seededNonce(4), confirmationKey, new Uint8Array(31)))
        expectInvalidBindingInput(() => buildAccountBindingMessage(seededNonce(4), new Uint8Array(10), networkId))
    })
})

describe("buildBindingMessages — internal networkId derivation", () => {
    it("derives networkId identically to computeNetworkId and deriveKeys, for a spread of secrets", () => {
        for (let i = 0; i < 6; i += 1) {
            const secret = seededSecret(i)
            const account = deriveAccountKeypair(secret)
            const nonce = seededNonce(i)
            const confirmationKey = seededP256Key(i).publicKey

            const { networkId, deviceBindingMessage, accountBindingMessage } = buildBindingMessages(
                nonce,
                account.uncompressedPublicKey,
                confirmationKey,
                HOLDER,
                REQUEST
            )

            expect(networkId).toBe(computeNetworkId(account.uncompressedPublicKey))
            expect(networkId).toBe(deriveKeys(secret).networkId)
            expect(deviceBindingMessage).toEqual(buildDeviceBindingMessage(nonce, networkId, HOLDER, REQUEST))
            expect(accountBindingMessage).toEqual(buildAccountBindingMessage(nonce, confirmationKey, networkId))
        }
    })

    it("rejects a malformed accountUncompressedPublicKey with InvalidBindingInputError", () => {
        const confirmationKey = seededP256Key(0).publicKey
        const fn = () => buildBindingMessages(seededNonce(0), new Uint8Array(20), confirmationKey, HOLDER, REQUEST)
        expectInvalidBindingInput(fn)
    })

    it("lays the device message out as nonce || networkId || holder || request", () => {
        const account = deriveAccountKeypair(SECRET_ONES)
        const nonce = seededNonce(2)
        const { networkId, deviceBindingMessage } = buildBindingMessages(
            nonce,
            account.uncompressedPublicKey,
            seededP256Key(2).publicKey,
            HOLDER,
            REQUEST
        )

        expect(deviceBindingMessage).toHaveLength(128)
        expect(deviceBindingMessage.slice(0, 32)).toEqual(nonce)
        expect(deviceBindingMessage.slice(32, 64)).toEqual(hexToBytes(networkId))
        expect(deviceBindingMessage.slice(64, 96)).toEqual(HOLDER)
        expect(deviceBindingMessage.slice(96, 128)).toEqual(REQUEST)
    })

    it.each([
        ["holderKeyCommitment", new Uint8Array(31)],
        ["requestCommitment", new Uint8Array(33)],
        ["holderKeyCommitment", `0x${"11".repeat(31)}` as Hex],
        ["requestCommitment", `0x${"11".repeat(33)}` as Hex]
    ])("rejects a wrong-length %s", (name, wrong) => {
        const account = deriveAccountKeypair(SECRET_ONES)
        const confirmationKey = seededP256Key(0).publicKey
        const holder = name === "holderKeyCommitment" ? wrong : HOLDER
        const request = name === "requestCommitment" ? wrong : REQUEST
        expectInvalidBindingInput(() =>
            buildBindingMessages(seededNonce(0), account.uncompressedPublicKey, confirmationKey, holder, request)
        )
    })
})

describe("signAccountBinding / verifyAccountBindingSignature", () => {
    const account = deriveAccountKeypair(SECRET_ONES)
    const confirmationKey = seededP256Key(2).publicKey
    const nonce = seededNonce(5)

    it("networkId matches computeNetworkId / deriveKeys", () => {
        const { networkId } = signAccountBinding(account.privateKey, nonce, confirmationKey)
        expect(networkId).toBe(computeNetworkId(account.uncompressedPublicKey))
        expect(networkId).toBe(deriveKeys(SECRET_ONES).networkId)
    })

    it("is deterministic: signing twice yields the identical signature", () => {
        const first = signAccountBinding(account.privateKey, nonce, confirmationKey)
        const second = signAccountBinding(account.privateKey, nonce, confirmationKey)
        expect(second.signature).toBe(first.signature)
        expect(second.networkId).toBe(first.networkId)
    })

    it("produces a 64-byte compact signature with low S (s < n/2)", () => {
        const { signature } = signAccountBinding(account.privateKey, nonce, confirmationKey)
        const sigBytes = hexToBytes(signature)
        expect(sigBytes).toHaveLength(64)

        const s = BigInt(bytesToHex(sigBytes.slice(32, 64)))
        expect(s).toBeLessThan(N / 2n)
    })

    it("the signed digest is the EIP-191 personal-sign digest of the 96-byte accountBindingMessage, cross-verified with raw secp256k1.verify", () => {
        const { signature, networkId } = signAccountBinding(account.privateKey, nonce, confirmationKey)
        const message = buildAccountBindingMessage(nonce, confirmationKey, networkId)
        expect(message).toHaveLength(96)

        const digest = eip191Digest(message)
        const sig = secp256k1.Signature.fromCompact(hexToBytes(signature))

        expect(secp256k1.verify(sig.toCompactRawBytes(), digest, hexToBytes(account.uncompressedPublicKey))).toBe(true)
    })

    it("verifyAccountBindingSignature accepts a genuine signature and rejects a wrong key", () => {
        const { signature } = signAccountBinding(account.privateKey, nonce, confirmationKey)

        expect(
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: account.uncompressedPublicKey,
                signature
            })
        ).toBe(true)

        const otherAccount = deriveAccountKeypair(SECRET_TWOS)
        expect(
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: otherAccount.uncompressedPublicKey,
                signature
            })
        ).toBe(false)
    })

    it("verifyAccountBindingSignature accepts accountPublicKey in 33B/65B/64B form identically", () => {
        const { signature } = signAccountBinding(account.privateKey, nonce, confirmationKey)
        const raw64 = hexToBytes(account.uncompressedPublicKey).slice(1)

        for (const key of [account.publicKey, account.uncompressedPublicKey, raw64]) {
            expect(verifyAccountBindingSignature({ nonce, confirmationKey, accountPublicKey: key, signature })).toBe(
                true
            )
        }
    })

    it("rejects malformed nonce/confirmationKey/accountPublicKey/signature with InvalidBindingInputError", () => {
        const { signature } = signAccountBinding(account.privateKey, nonce, confirmationKey)

        const badNonce = () =>
            verifyAccountBindingSignature({
                nonce: new Uint8Array(31),
                confirmationKey,
                accountPublicKey: account.uncompressedPublicKey,
                signature
            })
        expectInvalidBindingInput(badNonce)
        expectInvalidBindingInput(() =>
            verifyAccountBindingSignature({
                nonce,
                confirmationKey: new Uint8Array(10),
                accountPublicKey: account.uncompressedPublicKey,
                signature
            })
        )
        expectInvalidBindingInput(() =>
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: new Uint8Array(20),
                signature
            })
        )

        // Right length (65 bytes, 0x04 prefix), but off-curve coordinates.
        const offCurveKey = hexToBytes(account.uncompressedPublicKey).slice()
        offCurveKey[64] ^= 0xff
        expectInvalidBindingInput(() =>
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: offCurveKey,
                signature
            })
        )
        expectInvalidBindingInput(() =>
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: account.uncompressedPublicKey,
                signature: new Uint8Array(63)
            })
        )
    })

    it("rejects a high-S variant (s' = n - s) of a genuine signature: lowS IS enforced for sig_A", () => {
        const { signature } = signAccountBinding(account.privateKey, nonce, confirmationKey)
        const sig = secp256k1.Signature.fromCompact(hexToBytes(signature))
        const highS = new secp256k1.Signature(sig.r, N - sig.s)

        expect(highS.hasHighS()).toBe(true)
        expect(
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: account.uncompressedPublicKey,
                signature: highS.toCompactRawBytes()
            })
        ).toBe(false)
    })

    it("rejects the 65-byte r || s || v form real wallets' personal_sign emits with InvalidBindingInputError", () => {
        const { signature } = signAccountBinding(account.privateKey, nonce, confirmationKey)

        expectInvalidBindingInput(() =>
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: account.uncompressedPublicKey,
                signature: concatBytes(hexToBytes(signature), new Uint8Array([27]))
            })
        )
    })

    it("rejects malformed hex-string inputs with InvalidBindingInputError, not a raw TypeError", () => {
        const { signature } = signAccountBinding(account.privateKey, nonce, confirmationKey)

        expectInvalidBindingInput(() =>
            verifyAccountBindingSignature({
                nonce: "0xzz",
                confirmationKey,
                accountPublicKey: account.uncompressedPublicKey,
                signature
            })
        )
        expectInvalidBindingInput(() =>
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: "0xabc",
                signature
            })
        )
    })

    it("a well-formed but incorrect signature returns false, never throws", () => {
        const { signature } = signAccountBinding(account.privateKey, nonce, confirmationKey)
        const flipped = hexToBytes(signature)
        flipped[0] ^= 0xff

        expect(() =>
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: account.uncompressedPublicKey,
                signature: flipped
            })
        ).not.toThrow()
        expect(
            verifyAccountBindingSignature({
                nonce,
                confirmationKey,
                accountPublicKey: account.uncompressedPublicKey,
                signature: flipped
            })
        ).toBe(false)
    })
})

describe("verifyDeviceBindingSignature (P-256, sig_B)", () => {
    // Not `seededP256Key`: the high-S sub-test needs the raw deterministic signature to come out low-S
    // so flipping it yields a genuine high-S counterexample.
    const priv = keccak_256(utf8ToBytes("coordination-network/identity/test-p256-key/v1:3"))
    const confirmationKey = p256.getPublicKey(priv, false)
    const nonce = seededNonce(6)
    const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)
    const message = buildDeviceBindingMessage(nonce, networkId, HOLDER, REQUEST)

    it("verifies a deterministic noble P-256 signature as compact bytes", () => {
        const sig = p256.sign(message, priv, { prehash: true })
        const compact = sig.toCompactRawBytes()

        expect(
            verifyDeviceBindingSignature({ nonce, networkId, confirmationKey, ...COMMITMENTS, signature: compact })
        ).toBe(true)
        expect(bytesToHex(compact)).toMatch(/^0x[0-9a-f]{128}$/)
    })

    it("verifies the identical signature re-encoded as DER", () => {
        const sig = p256.sign(message, priv, { prehash: true })
        const der = sig.toDERRawBytes()

        expect(der[0]).toBe(0x30)
        expect(
            verifyDeviceBindingSignature({ nonce, networkId, confirmationKey, ...COMMITMENTS, signature: der })
        ).toBe(true)
    })

    it("verifies a high-S variant (s' = n - s), documenting that lowS is deliberately not enforced", () => {
        const sig = p256.sign(message, priv, { prehash: true })
        const highS = P256_N - sig.s
        const highSSig = new p256.Signature(sig.r, highS)

        expect(highSSig.hasHighS()).toBe(true)
        expect(
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                ...COMMITMENTS,
                signature: highSSig.toCompactRawBytes()
            })
        ).toBe(true)
    })

    it("rejects a signature over the wrong message or from the wrong key", () => {
        const sig = p256.sign(message, priv, { prehash: true })
        const compact = sig.toCompactRawBytes()

        const wrongNetworkId = hexToBytes(deriveKeys(SECRET_TWOS).networkId)
        expect(
            verifyDeviceBindingSignature({
                nonce,
                networkId: wrongNetworkId,
                confirmationKey,
                ...COMMITMENTS,
                signature: compact
            })
        ).toBe(false)

        const otherKey = seededP256Key(4).publicKey
        expect(
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey: otherKey,
                ...COMMITMENTS,
                signature: compact
            })
        ).toBe(false)
    })

    it("rejects a signature made over a different requestCommitment", () => {
        const compact = p256.sign(message, priv, { prehash: true }).toCompactRawBytes()

        expect(
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                holderKeyCommitment: HOLDER,
                requestCommitment: OTHER_REQUEST,
                signature: compact
            })
        ).toBe(false)
    })

    it("rejects a signature made over a different holderKeyCommitment", () => {
        const compact = p256.sign(message, priv, { prehash: true }).toCompactRawBytes()

        expect(
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                holderKeyCommitment: seededCommitment("holder", 1),
                requestCommitment: REQUEST,
                signature: compact
            })
        ).toBe(false)
    })

    it("rejects a signature over the holder and request fields in swapped order", () => {
        const swapped = concatBytes(nonce, networkId, REQUEST, HOLDER)
        const compact = p256.sign(swapped, priv, { prehash: true }).toCompactRawBytes()

        expect(
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                ...COMMITMENTS,
                signature: compact
            })
        ).toBe(false)
    })

    it("rejects a signature over a 96-byte message without the request commitment", () => {
        const legacy = concatBytes(nonce, networkId, HOLDER)
        const compact = p256.sign(legacy, priv, { prehash: true }).toCompactRawBytes()

        expect(
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                ...COMMITMENTS,
                signature: compact
            })
        ).toBe(false)
    })

    it.each([
        ["31-byte holderKeyCommitment", new Uint8Array(31), REQUEST],
        ["33-byte holderKeyCommitment", new Uint8Array(33), REQUEST],
        ["31-byte requestCommitment", HOLDER, new Uint8Array(31)],
        ["33-byte requestCommitment", HOLDER, new Uint8Array(33)],
        ["hex holderKeyCommitment of 31 bytes", `0x${"11".repeat(31)}` as Hex, REQUEST],
        ["hex holderKeyCommitment of 33 bytes", `0x${"11".repeat(33)}` as Hex, REQUEST],
        ["hex requestCommitment of 31 bytes", HOLDER, `0x${"11".repeat(31)}` as Hex],
        ["hex requestCommitment of 33 bytes", HOLDER, `0x${"11".repeat(33)}` as Hex]
    ])("rejects a %s", (_name, holderKeyCommitment, requestCommitment) => {
        const compact = p256.sign(message, priv, { prehash: true }).toCompactRawBytes()

        expectInvalidBindingInput(() =>
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                holderKeyCommitment,
                requestCommitment,
                signature: compact
            })
        )
    })

    it("rejects a requestCommitment that is not 32 bytes", () => {
        const compact = p256.sign(message, priv, { prehash: true }).toCompactRawBytes()

        expectInvalidBindingInput(() =>
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                holderKeyCommitment: HOLDER,
                requestCommitment: new Uint8Array(31),
                signature: compact
            })
        )
    })

    it("rejects a garbage 63-byte signature with InvalidBindingInputError", () => {
        const fn = () =>
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                ...COMMITMENTS,
                signature: new Uint8Array(63).fill(0xab)
            })
        expectInvalidBindingInput(fn)
    })

    it.each([
        ["an empty signature", new Uint8Array(0)],
        ["65-byte non-DER garbage (leading byte != 0x30)", new Uint8Array(65).fill(0x02)],
        ["a truncated DER body starting 0x30", new Uint8Array([0x30, 0x44, 0x02, 0x20])],
        ["an out-of-range 64-byte compact (r, s >= n)", new Uint8Array(64).fill(0xff)]
    ])("rejects %s with InvalidBindingInputError", (_name, signature) => {
        expectInvalidBindingInput(() =>
            verifyDeviceBindingSignature({ nonce, networkId, confirmationKey, ...COMMITMENTS, signature })
        )
    })

    it("rejects a valid DER signature whose SEQUENCE tag is corrupted", () => {
        const corrupted = p256.sign(message, priv, { prehash: true }).toDERRawBytes().slice()
        corrupted[0] = 0x31

        expectInvalidBindingInput(() =>
            verifyDeviceBindingSignature({ nonce, networkId, confirmationKey, ...COMMITMENTS, signature: corrupted })
        )
    })

    it("rejects a malformed hex-string signature with InvalidBindingInputError, not a raw TypeError", () => {
        expectInvalidBindingInput(() =>
            verifyDeviceBindingSignature({ nonce, networkId, confirmationKey, ...COMMITMENTS, signature: "0xabc" })
        )
    })

    it("rejects malformed nonce/networkId/confirmationKey with InvalidBindingInputError", () => {
        const sig = p256.sign(message, priv, { prehash: true }).toCompactRawBytes()

        const badNonce = () =>
            verifyDeviceBindingSignature({
                nonce: new Uint8Array(10),
                networkId,
                confirmationKey,
                ...COMMITMENTS,
                signature: sig
            })
        expectInvalidBindingInput(badNonce)
        expectInvalidBindingInput(() =>
            verifyDeviceBindingSignature({
                nonce,
                networkId: new Uint8Array(10),
                confirmationKey,
                ...COMMITMENTS,
                signature: sig
            })
        )
        expectInvalidBindingInput(() =>
            verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey: new Uint8Array(10),
                ...COMMITMENTS,
                signature: sig
            })
        )
    })
})

describe("verifyCredentialBinding — the mutual-binding attack test", () => {
    const secretA = SECRET_ONES
    const secretB = SECRET_TWOS

    const accountA = deriveAccountKeypair(secretA)
    const accountB = deriveAccountKeypair(secretB)
    const networkIdA = computeNetworkId(accountA.uncompressedPublicKey)
    const networkIdB = computeNetworkId(accountB.uncompressedPublicKey)

    const { privateKey: devicePriv, publicKey: confirmationKey } = seededP256Key(7)
    const nonce = seededNonce(8)

    function deviceSignatureFor(networkId: Hex): Uint8Array {
        const message = buildDeviceBindingMessage(nonce, hexToBytes(networkId), HOLDER, REQUEST)
        return p256.sign(message, devicePriv, { prehash: true }).toCompactRawBytes()
    }

    it("valid: true when both signatures name the same networkId (A/A and B/B)", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const resultA = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountA.uncompressedPublicKey,
            confirmationKey,
            ...COMMITMENTS,
            accountSignature: sigA,
            deviceSignature: deviceSignatureFor(networkIdA)
        })
        expect(resultA).toEqual({ valid: true, networkId: networkIdA })

        const { signature: sigB } = signAccountBinding(accountB.privateKey, nonce, confirmationKey)
        const resultB = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountB.uncompressedPublicKey,
            confirmationKey,
            ...COMMITMENTS,
            accountSignature: sigB,
            deviceSignature: deviceSignatureFor(networkIdB)
        })
        expect(resultB).toEqual({ valid: true, networkId: networkIdB })
    })

    it("valid: false when the device signature names the OTHER identity's networkId (both directions)", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const crossedAB = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountA.uncompressedPublicKey,
            confirmationKey,
            ...COMMITMENTS,
            accountSignature: sigA,
            deviceSignature: deviceSignatureFor(networkIdB) // device signed B's networkId, not A's
        })
        expect(crossedAB.valid).toBe(false)
        expect(crossedAB.networkId).toBe(networkIdA) // issuer still learns the claimed identity

        const { signature: sigB } = signAccountBinding(accountB.privateKey, nonce, confirmationKey)
        const crossedBA = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountB.uncompressedPublicKey,
            confirmationKey,
            ...COMMITMENTS,
            accountSignature: sigB,
            deviceSignature: deviceSignatureFor(networkIdA) // device signed A's networkId, not B's
        })
        expect(crossedBA.valid).toBe(false)
        expect(crossedBA.networkId).toBe(networkIdB)
    })

    it("valid: false when the account signature comes from the OTHER identity (device correctly names A)", () => {
        // Attack-matrix account-side mismatch: B's key signs, but both messages name A.
        const { signature: sigFromB } = signAccountBinding(accountB.privateKey, nonce, confirmationKey)
        const result = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountA.uncompressedPublicKey,
            confirmationKey,
            ...COMMITMENTS,
            accountSignature: sigFromB,
            deviceSignature: deviceSignatureFor(networkIdA)
        })
        expect(result.valid).toBe(false)
        expect(result.networkId).toBe(networkIdA)
    })

    it("accepts a 33-byte compressed accountPublicKey at the gate level", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const result = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountA.publicKey,
            confirmationKey,
            ...COMMITMENTS,
            accountSignature: sigA,
            deviceSignature: deviceSignatureFor(networkIdA)
        })
        expect(result).toEqual({ valid: true, networkId: networkIdA })
    })

    it("valid: false for a high-S variant of the account signature (sig_A lowS enforced at the gate too)", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const sig = secp256k1.Signature.fromCompact(hexToBytes(sigA))
        const highS = new secp256k1.Signature(sig.r, N - sig.s)

        const result = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountA.uncompressedPublicKey,
            confirmationKey,
            ...COMMITMENTS,
            accountSignature: highS.toCompactRawBytes(),
            deviceSignature: deviceSignatureFor(networkIdA)
        })
        expect(result.valid).toBe(false)
    })

    it("valid: false when the device signature commits to a different request", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const result = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountA.uncompressedPublicKey,
            confirmationKey,
            holderKeyCommitment: HOLDER,
            requestCommitment: OTHER_REQUEST,
            accountSignature: sigA,
            deviceSignature: deviceSignatureFor(networkIdA)
        })
        expect(result.valid).toBe(false)
    })

    it("valid: false when the device signature commits to a different holderKeyCommitment", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const result = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountA.uncompressedPublicKey,
            confirmationKey,
            holderKeyCommitment: seededCommitment("holder", 1),
            requestCommitment: REQUEST,
            accountSignature: sigA,
            deviceSignature: deviceSignatureFor(networkIdA)
        })
        expect(result.valid).toBe(false)
    })

    it.each([
        ["holderKeyCommitment", new Uint8Array(31)],
        ["requestCommitment", new Uint8Array(33)],
        ["holderKeyCommitment", `0x${"11".repeat(33)}` as Hex],
        ["requestCommitment", `0x${"11".repeat(31)}` as Hex]
    ])("rejects a wrong-length %s with InvalidBindingInputError", (name, wrong) => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        expectInvalidBindingInput(() =>
            verifyCredentialBinding({
                nonce,
                accountPublicKey: accountA.uncompressedPublicKey,
                confirmationKey,
                ...COMMITMENTS,
                [name]: wrong,
                accountSignature: sigA,
                deviceSignature: deviceSignatureFor(networkIdA)
            })
        )
    })

    it("returns networkId even when valid is false, for issuer-side eligibility checks", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const result = verifyCredentialBinding({
            nonce,
            accountPublicKey: accountA.uncompressedPublicKey,
            confirmationKey,
            ...COMMITMENTS,
            accountSignature: sigA,
            deviceSignature: deviceSignatureFor(networkIdB)
        })
        expect(result.networkId).toBe(networkIdA)
    })

    it("flipped-byte negatives on nonce/hash/networkId/signature all return false without throwing", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const deviceSig = deviceSignatureFor(networkIdA)

        // A flipped nonce fails both checks — both messages embed it.
        const flippedNonce = nonce.slice()
        flippedNonce[0] ^= 0xff

        const withFlippedNonce = () =>
            verifyCredentialBinding({
                nonce: flippedNonce,
                accountPublicKey: accountA.uncompressedPublicKey,
                confirmationKey,
                ...COMMITMENTS,
                accountSignature: sigA,
                deviceSignature: deviceSig
            })
        expect(withFlippedNonce).not.toThrow()
        expect(withFlippedNonce().valid).toBe(false)

        // Use a different, valid key so this exercises the hash mismatch, not a shape error.
        const otherConfirmationKey = seededP256Key(9).publicKey
        const withFlippedKey = () =>
            verifyCredentialBinding({
                nonce,
                accountPublicKey: accountA.uncompressedPublicKey,
                confirmationKey: otherConfirmationKey,
                ...COMMITMENTS,
                accountSignature: sigA,
                deviceSignature: deviceSig
            })
        expect(withFlippedKey).not.toThrow()
        expect(withFlippedKey().valid).toBe(false)

        const flippedSig = hexToBytes(sigA)
        flippedSig[0] ^= 0xff
        const withFlippedSig = () =>
            verifyCredentialBinding({
                nonce,
                accountPublicKey: accountA.uncompressedPublicKey,
                confirmationKey,
                ...COMMITMENTS,
                accountSignature: flippedSig,
                deviceSignature: deviceSig
            })
        expect(withFlippedSig).not.toThrow()
        expect(withFlippedSig().valid).toBe(false)

        const flippedDeviceSig = deviceSig.slice()
        flippedDeviceSig[0] ^= 0xff
        const withFlippedDeviceSig = () =>
            verifyCredentialBinding({
                nonce,
                accountPublicKey: accountA.uncompressedPublicKey,
                confirmationKey,
                ...COMMITMENTS,
                accountSignature: sigA,
                deviceSignature: flippedDeviceSig
            })
        expect(withFlippedDeviceSig).not.toThrow()
        expect(withFlippedDeviceSig().valid).toBe(false)
    })

    it("rejects malformed top-level inputs with InvalidBindingInputError", () => {
        const { signature: sigA } = signAccountBinding(accountA.privateKey, nonce, confirmationKey)
        const deviceSig = deviceSignatureFor(networkIdA)

        const badNonce = () =>
            verifyCredentialBinding({
                nonce: new Uint8Array(10),
                accountPublicKey: accountA.uncompressedPublicKey,
                confirmationKey,
                ...COMMITMENTS,
                accountSignature: sigA,
                deviceSignature: deviceSig
            })
        expectInvalidBindingInput(badNonce)
        expectInvalidBindingInput(() =>
            verifyCredentialBinding({
                nonce,
                accountPublicKey: new Uint8Array(20),
                confirmationKey,
                ...COMMITMENTS,
                accountSignature: sigA,
                deviceSignature: deviceSig
            })
        )
    })
})

describe("WebCrypto interop (real platform-produced P-256 signature)", () => {
    it("verifies a raw 64-byte signature produced by globalThis.crypto.subtle", async () => {
        const subtle = globalThis.crypto.subtle

        const keyPair = await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])
        const rawPublicKey = new Uint8Array(await subtle.exportKey("raw", keyPair.publicKey))

        const nonce = seededNonce(10)
        const networkId = hexToBytes(deriveKeys(SECRET_ONES).networkId)
        const message = buildDeviceBindingMessage(nonce, networkId, HOLDER, REQUEST)

        const signatureBuffer = await subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            keyPair.privateKey,
            message as BufferSource
        )
        const signature = new Uint8Array(signatureBuffer)

        expect(signature).toHaveLength(64)
        expect(
            verifyDeviceBindingSignature({ nonce, networkId, confirmationKey: rawPublicKey, ...COMMITMENTS, signature })
        ).toBe(true)
    })
})
