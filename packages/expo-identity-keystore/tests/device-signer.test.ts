import { describe, expect, it, jest } from "@jest/globals"
import { p256 } from "@noble/curves/p256"
import { createDeviceSigner } from "../src/device-signer"
import { base64ToBytes } from "../src/encoding"
import { SoftwareKeystore } from "../src/software-keystore"

function jwkToPublicKey(jwk: { x: string; y: string }): Uint8Array {
    const x = base64ToBytes(jwk.x.replace(/-/g, "+").replace(/_/g, "/"))
    const y = base64ToBytes(jwk.y.replace(/-/g, "+").replace(/_/g, "/"))
    return new Uint8Array([0x04, ...x, ...y])
}

const prompt = { title: "Share a proof", subtitle: "Proves your credential" }

describe("createDeviceSigner", () => {
    it("signs in message mode with a compact low-S signature the public key verifies", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("device-key", { purpose: "sign" })
        const signer = createDeviceSigner(keystore, "device-key", prompt)
        const jwk = await signer.getPublicKeyJwk()
        const message = new TextEncoder().encode("device signer message")

        const signature = await signer.sign(message)

        expect(signature).toHaveLength(64)
        expect(p256.Signature.fromCompact(signature).hasHighS()).toBe(false)
        expect(p256.verify(signature, message, jwkToPublicKey(jwk), { prehash: true, lowS: true })).toBe(true)
    })

    it("signs a raw digest with signDigest and rejects a 31-byte one", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("device-key", { purpose: "sign" })
        const signer = createDeviceSigner(keystore, "device-key", prompt)
        const jwk = await signer.getPublicKeyJwk()
        const digest = p256.utils.randomSecretKey()

        const signature = await signer.signDigest(digest)

        expect(p256.verify(signature, digest, jwkToPublicKey(jwk), { prehash: false, lowS: true })).toBe(true)
        await expect(signer.signDigest(new Uint8Array(31))).rejects.toThrow()
    })

    it("caches the public key: getPublicKey runs once across getPublicKeyJwk/sign/signDigest", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("device-key", { purpose: "sign" })
        const getPublicKey = jest.spyOn(keystore, "getPublicKey")
        const signer = createDeviceSigner(keystore, "device-key", prompt)

        const first = await signer.getPublicKeyJwk()
        await signer.sign(new TextEncoder().encode("m"))
        await signer.signDigest(p256.utils.randomSecretKey())
        const second = await signer.getPublicKeyJwk()

        expect(getPublicKey).toHaveBeenCalledTimes(1)
        expect(second).toEqual(first)
    })

    it("never provisions the alias: an unprovisioned alias rejects without calling generateKey", async () => {
        const keystore = new SoftwareKeystore()
        const generateKey = jest.spyOn(keystore, "generateKey")
        const signer = createDeviceSigner(keystore, "never-provisioned", prompt)

        await expect(signer.getPublicKeyJwk()).rejects.toThrow()
        await expect(signer.sign(new TextEncoder().encode("m"))).rejects.toThrow()

        expect(generateKey).not.toHaveBeenCalled()
    })

    it("propagates a getPublicKey rejection without caching it, so a later call retries", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("device-key", { purpose: "sign" })
        const rejection = new Error("keystore temporarily locked")
        const getPublicKey = jest.spyOn(keystore, "getPublicKey").mockRejectedValueOnce(rejection)
        const signer = createDeviceSigner(keystore, "device-key", prompt)

        await expect(signer.getPublicKeyJwk()).rejects.toThrow(rejection)

        const jwk = await signer.getPublicKeyJwk()

        expect(jwk).toEqual({ kty: "EC", crv: "P-256", x: expect.any(String), y: expect.any(String) })
        expect(getPublicKey).toHaveBeenCalledTimes(2)
    })

    it("passes the prompt bound at construction to every sign and signDigest, and none to getPublicKeyJwk", async () => {
        const keystore = new SoftwareKeystore()
        await keystore.generateKey("device-key", { purpose: "sign" })
        const signer = createDeviceSigner(keystore, "device-key", prompt)

        await signer.getPublicKeyJwk()
        expect(keystore.prompts).toEqual([])

        await signer.sign(new TextEncoder().encode("m"))
        await signer.signDigest(p256.utils.randomSecretKey())

        expect(keystore.prompts).toEqual([prompt, prompt])
    })
})
