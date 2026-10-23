import { describe, expect, it } from "@jest/globals"
import { p256 } from "@noble/curves/p256"
import { base64ToBytes, bytesToBase64 } from "../src/encoding"
import { SoftwareKeystore } from "../src/software-keystore"

const sign = { purpose: "sign" } as const
const agree = { purpose: "agree" } as const
const prompt = { title: "Share a proof", subtitle: "Proves your credential" }

describe("SoftwareKeystore", () => {
    it("generateKey() returns the public key and a SOFTWARE security level", async () => {
        const keystore = new SoftwareKeystore()
        const generated = await keystore.generateKey("alias", sign)

        expect(generated).toEqual({ publicKey: expect.any(String), securityLevel: "SOFTWARE" })
        expect(base64ToBytes(generated.publicKey)).toHaveLength(65)
        expect(await keystore.getSecurityLevel("alias")).toBe("SOFTWARE")
    })

    it("ignores an attestation challenge and has no attestation chain", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("alias", { ...sign, attestationChallenge: bytesToBase64(new Uint8Array(4)) })

        expect(await keystore.getAttestationChain("alias")).toEqual([])
        await expect(keystore.getAttestationChain("missing")).rejects.toThrow()
    })

    it("hasKey() reports whether an alias exists", async () => {
        const keystore = new SoftwareKeystore()

        expect(await keystore.hasKey("alias")).toBe(false)

        await keystore.generateKey("alias", sign)

        expect(await keystore.hasKey("alias")).toBe(true)
    })

    it("getPublicKey() returns the same key generateKey returned, without rotating it", async () => {
        const keystore = new SoftwareKeystore()
        const { publicKey } = await keystore.generateKey("alias", agree)

        expect(await keystore.getPublicKey("alias")).toBe(publicKey)
        expect(await keystore.getPublicKey("alias")).toBe(publicKey)
    })

    it("sign() produces a DER signature noble verifies in message mode", async () => {
        const keystore = new SoftwareKeystore()
        const publicKey = base64ToBytes((await keystore.generateKey("alias", sign)).publicKey)
        const message = new TextEncoder().encode("sign test vector")

        const signatureDer = base64ToBytes(await keystore.sign("alias", bytesToBase64(message), prompt))

        expect(p256.verify(signatureDer, message, publicKey, { prehash: true, lowS: false })).toBe(true)
    })

    it("signDigest() produces a DER signature noble verifies with prehash: false", async () => {
        const keystore = new SoftwareKeystore()
        const publicKey = base64ToBytes((await keystore.generateKey("alias", sign)).publicKey)
        const digest = p256.utils.randomSecretKey() // any 32 random bytes

        const signatureDer = base64ToBytes(await keystore.signDigest("alias", bytesToBase64(digest), prompt))

        expect(p256.verify(signatureDer, digest, publicKey, { prehash: false, lowS: false })).toBe(true)
    })

    it("signDigest() rejects a digest that isn't 32 bytes", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("alias", sign)

        await expect(keystore.signDigest("alias", bytesToBase64(new Uint8Array(31)), prompt)).rejects.toThrow()
    })

    it("ecdh() matches noble's getSharedSecret", async () => {
        const keystore = new SoftwareKeystore()
        const { publicKey } = await keystore.generateKey("alias", agree)

        const peerPrivateKey = p256.utils.randomSecretKey()
        const peerPublicKey = p256.getPublicKey(peerPrivateKey, false)

        const sharedSecretBase64 = await keystore.ecdh("alias", bytesToBase64(peerPublicKey), prompt)
        const expected = p256.getSharedSecret(peerPrivateKey, base64ToBytes(publicKey), true).slice(1)

        expect(sharedSecretBase64).toBe(bytesToBase64(expected))
    })

    it("refuses sign() and signDigest() on an agree key", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("agreement", agree)

        await expect(keystore.sign("agreement", bytesToBase64(new Uint8Array(1)), prompt)).rejects.toThrow(
            /purpose 'agree', not 'sign'/
        )
        await expect(keystore.signDigest("agreement", bytesToBase64(new Uint8Array(32)), prompt)).rejects.toThrow(
            /purpose 'agree', not 'sign'/
        )
    })

    it("refuses ecdh() on a sign key", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("signing", sign)
        const peerPublicKey = p256.getPublicKey(p256.utils.randomSecretKey(), false)

        await expect(keystore.ecdh("signing", bytesToBase64(peerPublicKey), prompt)).rejects.toThrow(
            /purpose 'sign', not 'agree'/
        )
    })

    it("takes the purpose of the latest generateKey for an alias", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("alias", sign)
        await keystore.generateKey("alias", agree)

        await expect(keystore.sign("alias", bytesToBase64(new Uint8Array(1)), prompt)).rejects.toThrow(
            /purpose 'agree', not 'sign'/
        )
    })

    it("records the prompt of every sign, signDigest and ecdh, in order", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("signing", sign)
        await keystore.generateKey("agreement", agree)
        const peerPublicKey = p256.getPublicKey(p256.utils.randomSecretKey(), false)
        const first = { title: "first" }
        const second = { title: "second", subtitle: "two" }
        const third = { title: "third" }

        expect(keystore.prompts).toEqual([])

        await keystore.sign("signing", bytesToBase64(new Uint8Array(1)), first)
        await keystore.signDigest("signing", bytesToBase64(new Uint8Array(32)), second)
        await keystore.ecdh("agreement", bytesToBase64(peerPublicKey), third)

        expect(keystore.prompts).toEqual([first, second, third])
    })

    it("records no prompt for a call it refuses before signing", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("signing", sign)
        await keystore.generateKey("agreement", agree)

        await expect(keystore.sign("agreement", bytesToBase64(new Uint8Array(1)), prompt)).rejects.toThrow()
        await expect(keystore.signDigest("signing", bytesToBase64(new Uint8Array(31)), prompt)).rejects.toThrow()
        await expect(keystore.sign("missing", bytesToBase64(new Uint8Array(1)), prompt)).rejects.toThrow()

        expect(keystore.prompts).toEqual([])
    })

    it("records no prompt for key reads, deletes or generation", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("alias", sign)
        await keystore.hasKey("alias")
        await keystore.getPublicKey("alias")
        await keystore.getSecurityLevel("alias")
        await keystore.deleteKey("alias")
        await keystore.eraseAll()

        expect(keystore.prompts).toEqual([])
    })

    it("throws for an unknown alias", async () => {
        const keystore = new SoftwareKeystore()

        await expect(keystore.getPublicKey("missing")).rejects.toThrow()
        await expect(keystore.sign("missing", bytesToBase64(new Uint8Array(1)), prompt)).rejects.toThrow()
        await expect(keystore.signDigest("missing", bytesToBase64(new Uint8Array(32)), prompt)).rejects.toThrow()
        await expect(keystore.ecdh("missing", bytesToBase64(new Uint8Array(65)), prompt)).rejects.toThrow()
        await expect(keystore.getSecurityLevel("missing")).rejects.toThrow()
    })

    it("deleteKey() removes an alias; eraseAll() removes every alias and reports the count", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("one", sign)
        await keystore.generateKey("two", agree)

        await keystore.deleteKey("one")
        await expect(keystore.getSecurityLevel("one")).rejects.toThrow()

        expect(await keystore.eraseAll()).toBe(1)
        await expect(keystore.getSecurityLevel("two")).rejects.toThrow()
    })
})
