import { describe, expect, it } from "@jest/globals"
import { p256 } from "@noble/curves/nist.js"
import { Identity } from "@semaphore-protocol/identity"
import { deriveEddsaKeypair, eddsaPeerPointBytes } from "@coordination-network/identity"
import { MemoryStore } from "@coordination-network/wallet"
import {
    buildWallet,
    createIdentitySeedCache,
    listingSigner,
    neverLoadChainState,
    neverSeed,
    resolveIdentitySeed
} from "../src/wallet-factory"
import type { UserAppPorts } from "../src/types"
import { RecordingProofGenerator } from "./support/harness"
import { createTestDeviceKey, type TestDeviceKey } from "./support/test-device-key"
import { FakeHttpClient } from "./support/fake-http"

describe("neverLoadChainState", () => {
    it("throws if ever actually invoked", async () => {
        await expect(neverLoadChainState()).rejects.toThrow(/must not be requested/)
    })
})

describe("what a listing wallet holds instead of keys", () => {
    it("has a seed that throws if ever actually asked for", async () => {
        await expect(neverSeed()).rejects.toThrow(/must not ask the device key for the identity seed/)
    })

    it("has a signer that reads the public key without a prompt and refuses to sign", async () => {
        const deviceKey = createTestDeviceKey()
        const signer = listingSigner(deviceKey)

        expect(await signer.getPublicKeyJwk()).toEqual(await deviceKey.getPublicKeyJwk())
        await expect(signer.sign(new Uint8Array(1))).rejects.toThrow(/must not ask the device key to sign/)
        await expect(signer.signDigest(new Uint8Array(32))).rejects.toThrow(/must not ask the device key to sign/)
        expect(deviceKey.prompts).toEqual([])
    })
})

describe("buildWallet", () => {
    function portsWith(deviceKey: TestDeviceKey): UserAppPorts {
        return {
            store: new MemoryStore(),
            deviceKey,
            proofGenerator: new RecordingProofGenerator(),
            http: new FakeHttpClient(),
            consent: async () => true,
            review: async () => true,
            directory: { issuerKeyLeavesOf: async () => [] },
            roots: {
                currentRoots: async () => ({ approvedIssuerRoot: 0n, approvedIssuerLeafCount: 0, revocationRoot: 0n })
            },
            progress: () => {}
        }
    }

    it("constructs a Wallet without a ports.now override", async () => {
        const deviceKey = createTestDeviceKey()
        const wallet = buildWallet(portsWith(deviceKey), createIdentitySeedCache(deviceKey), neverLoadChainState, null)
        expect(await wallet.listCredentials()).toEqual([])
        expect(deviceKey.calls).toEqual([])
    })

    it("resolveIdentitySeed returns exactly 32 bytes", async () => {
        const deviceKey = createTestDeviceKey()
        const seed = await resolveIdentitySeed(deviceKey)
        expect(seed).toHaveLength(32)
    })

    // The trap: `deriveEddsaKeypair.seed` is a 0x-prefixed hex *string*, and handing that string
    // rather than its raw bytes to `Identity` derives a different commitment (DERIVATION.md 12.4).
    it("resolveIdentitySeed opens the same Semaphore commitment the derived key claims", async () => {
        const devicePrivateKey = p256.utils.randomSecretKey()
        const deviceKey = createTestDeviceKey(devicePrivateKey)
        const expected = deriveEddsaKeypair(
            p256.getSharedSecret(devicePrivateKey, eddsaPeerPointBytes(), true).slice(1)
        )

        expect(new Identity(await resolveIdentitySeed(deviceKey)).commitment).toBe(expected.commitment)
        expect(Identity.generateCommitment(expected.publicKey)).toBe(expected.commitment)
        expect(new Identity(expected.seed).commitment).not.toBe(expected.commitment)
    })
})

describe("createIdentitySeedCache", () => {
    it("asks the key once and shares the answer, with the fixed unlock prompt", async () => {
        const deviceKey = createTestDeviceKey()
        const seeds = createIdentitySeedCache(deviceKey)

        const [first, second] = await Promise.all([seeds.resolve(), seeds.resolve()])
        expect(first).toBe(second)
        expect(await seeds.resolve()).toBe(first)
        expect(deviceKey.calls).toEqual(["ecdh"])
        expect(deviceKey.prompts).toEqual([
            { title: "Unlock your credentials", subtitle: "Needed once each time the app starts" }
        ])
    })

    it("forgets a rejection so the next call asks again", async () => {
        const deviceKey = createTestDeviceKey()
        const seeds = createIdentitySeedCache(deviceKey)
        deviceKey.failWith("ecdh", "USER_CANCELED")

        await expect(seeds.resolve()).rejects.toMatchObject({ code: "USER_CANCELED" })
        await expect(seeds.resolve()).resolves.toHaveLength(32)
        expect(deviceKey.calls).toEqual(["ecdh", "ecdh"])
    })

    it("asks again after clear", async () => {
        const deviceKey = createTestDeviceKey()
        const seeds = createIdentitySeedCache(deviceKey)

        await seeds.resolve()
        seeds.clear()
        await seeds.resolve()
        expect(deviceKey.calls).toEqual(["ecdh", "ecdh"])
    })
})
