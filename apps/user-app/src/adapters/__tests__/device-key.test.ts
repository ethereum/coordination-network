import { base64ToBytes, SoftwareKeystore, type Keystore } from "@coordination-network/expo-identity-keystore"
import { DeviceKeyError } from "@coordination-network/user-app-core"
import {
    AGREEMENT_KEY_ALIAS,
    createDeviceKey,
    eraseDeviceKey,
    LEGACY_AGREEMENT_KEY_ALIAS,
    LEGACY_DEVICE_KEY_ALIAS,
    LEGACY_SIGNING_KEY_ALIAS,
    replaceDeviceKeys,
    SIGNING_KEY_ALIAS
} from "../device-key"

// jest.mock's factory may only reference variables prefixed `mock`. Null means the native module is
// absent, which is what jest sees: the software fallback, the path Expo Go and iOS take.
let mockNative: Keystore | null = null

jest.mock("@coordination-network/expo-identity-keystore", () => {
    const actual = jest.requireActual("@coordination-network/expo-identity-keystore")
    return { ...actual, getKeystore: () => mockNative }
})

const prompt = { title: "Share a proof" }
const onInvalidated = jest.fn()
// Skips the backoff between re-reads of a missing alias.
const options = { onInvalidated, sleep: async () => undefined }

beforeEach(() => {
    mockNative = null
    onInvalidated.mockReset()
})

function nativeError(code: string): Error {
    return Object.assign(new Error(code), { code })
}

describe("createDeviceKey on the software fallback", () => {
    // Two instances would mint two device keys, opening different deviceKeyCommitments, so a
    // credential stored against one could never be presented against the other.
    it("returns the same device key across calls within a process", async () => {
        const first = await createDeviceKey(options)
        const second = await createDeviceKey(options)

        expect(await second.getPublicKeyJwk()).toEqual(await first.getPublicKeyJwk())
    })

    it("erases the fallback key, so the next call mints a fresh one", async () => {
        const before = await (await createDeviceKey(options)).getPublicKeyJwk()

        await eraseDeviceKey()

        const after = await (await createDeviceKey(options)).getPublicKeyJwk()
        expect(after).not.toEqual(before)
    })
})

describe("createDeviceKey's provisioning", () => {
    let keystore: SoftwareKeystore

    beforeEach(() => {
        keystore = new SoftwareKeystore()
        mockNative = keystore
    })

    it("generates a signing key and an agreement key when none exist", async () => {
        await createDeviceKey(options)

        expect(await keystore.hasKey(SIGNING_KEY_ALIAS)).toBe(true)
        expect(await keystore.hasKey(AGREEMENT_KEY_ALIAS)).toBe(true)
    })

    it("leaves a complete pair alone", async () => {
        await createDeviceKey(options)
        const generate = jest.spyOn(keystore, "generateKey")
        const publicKey = await keystore.getPublicKey(SIGNING_KEY_ALIAS)

        await createDeviceKey(options)

        expect(generate).not.toHaveBeenCalled()
        expect(await keystore.getPublicKey(SIGNING_KEY_ALIAS)).toBe(publicKey)
    })

    it("replaces the one-key build's key with the pair", async () => {
        await keystore.generateKey(LEGACY_DEVICE_KEY_ALIAS, { purpose: "sign" })

        await createDeviceKey(options)

        expect(await keystore.hasKey(LEGACY_DEVICE_KEY_ALIAS)).toBe(false)
        expect(await keystore.hasKey(SIGNING_KEY_ALIAS)).toBe(true)
        expect(await keystore.hasKey(AGREEMENT_KEY_ALIAS)).toBe(true)
    })

    it("replaces the unattested pair with an attested signing key, and an agreement key without a challenge", async () => {
        await keystore.generateKey(LEGACY_SIGNING_KEY_ALIAS, { purpose: "sign" })
        await keystore.generateKey(LEGACY_AGREEMENT_KEY_ALIAS, { purpose: "agree" })
        const generate = jest.spyOn(keystore, "generateKey")

        await createDeviceKey(options)

        expect(await keystore.hasKey(LEGACY_SIGNING_KEY_ALIAS)).toBe(false)
        expect(await keystore.hasKey(LEGACY_AGREEMENT_KEY_ALIAS)).toBe(false)
        expect(generate.mock.calls).toEqual([
            [SIGNING_KEY_ALIAS, { purpose: "sign", attestationChallenge: "dXJuOmNuOmRldmljZS1hdHRlc3RhdGlvbjp2MQ==" }],
            [AGREEMENT_KEY_ALIAS, { purpose: "agree" }]
        ])
    })

    it("generates nothing on the boot after the upgrade", async () => {
        await keystore.generateKey(LEGACY_SIGNING_KEY_ALIAS, { purpose: "sign" })
        await keystore.generateKey(LEGACY_AGREEMENT_KEY_ALIAS, { purpose: "agree" })
        await createDeviceKey(options)
        const generate = jest.spyOn(keystore, "generateKey")

        await createDeviceKey(options)

        expect(generate).not.toHaveBeenCalled()
    })

    it("deletes a leftover unattested pair beside a complete v2 pair without regenerating", async () => {
        await createDeviceKey(options)
        await keystore.generateKey(LEGACY_SIGNING_KEY_ALIAS, { purpose: "sign" })
        await keystore.generateKey(LEGACY_AGREEMENT_KEY_ALIAS, { purpose: "agree" })
        const generate = jest.spyOn(keystore, "generateKey")

        await createDeviceKey(options)

        expect(await keystore.hasKey(LEGACY_SIGNING_KEY_ALIAS)).toBe(false)
        expect(await keystore.hasKey(LEGACY_AGREEMENT_KEY_ALIAS)).toBe(false)
        expect(generate).not.toHaveBeenCalled()
    })

    it("deletes only the one-key build's key when the pair is complete", async () => {
        await createDeviceKey(options)
        await keystore.generateKey(LEGACY_DEVICE_KEY_ALIAS, { purpose: "sign" })
        const signingKey = await keystore.getPublicKey(SIGNING_KEY_ALIAS)
        const agreementKey = await keystore.getPublicKey(AGREEMENT_KEY_ALIAS)
        const generate = jest.spyOn(keystore, "generateKey")
        const deleteKey = jest.spyOn(keystore, "deleteKey")

        await createDeviceKey(options)

        expect(deleteKey.mock.calls).toEqual([[LEGACY_DEVICE_KEY_ALIAS]])
        expect(generate).not.toHaveBeenCalled()
        expect(await keystore.getPublicKey(SIGNING_KEY_ALIAS)).toBe(signingKey)
        expect(await keystore.getPublicKey(AGREEMENT_KEY_ALIAS)).toBe(agreementKey)
    })

    it.each([SIGNING_KEY_ALIAS, AGREEMENT_KEY_ALIAS])("regenerates both when only %s exists", async (alias) => {
        await keystore.generateKey(alias, { purpose: alias === SIGNING_KEY_ALIAS ? "sign" : "agree" })
        const lone = await keystore.getPublicKey(alias)

        await createDeviceKey(options)

        expect(await keystore.hasKey(SIGNING_KEY_ALIAS)).toBe(true)
        expect(await keystore.hasKey(AGREEMENT_KEY_ALIAS)).toBe(true)
        expect(await keystore.getPublicKey(alias)).not.toBe(lone)
    })
})

describe("createDeviceKey's re-probe of a missing alias", () => {
    let keystore: SoftwareKeystore
    const sleep = jest.fn(async () => undefined)

    beforeEach(async () => {
        keystore = new SoftwareKeystore()
        mockNative = keystore
        sleep.mockClear()
        await createDeviceKey(options)
    })

    // Android's containsAlias answers false for any KeyStoreException, so one read is not proof.
    it("keeps the pair when an alias reads missing once and then present", async () => {
        const realHasKey = keystore.hasKey.bind(keystore)
        const hasKey = jest.spyOn(keystore, "hasKey")
        hasKey.mockImplementation(async (alias) => (hasKey.mock.calls.length === 1 ? false : realHasKey(alias)))
        const deleteKey = jest.spyOn(keystore, "deleteKey")
        const generate = jest.spyOn(keystore, "generateKey")
        const publicKey = await keystore.getPublicKey(SIGNING_KEY_ALIAS)

        await createDeviceKey({ onInvalidated, sleep })

        expect(deleteKey).not.toHaveBeenCalled()
        expect(generate).not.toHaveBeenCalled()
        expect(await keystore.getPublicKey(SIGNING_KEY_ALIAS)).toBe(publicKey)
        expect(sleep).toHaveBeenCalledTimes(1)
    })

    it("reads a missing alias three times with backoff, then regenerates the pair", async () => {
        const realHasKey = keystore.hasKey.bind(keystore)
        const signingReads: number[] = []
        jest.spyOn(keystore, "hasKey").mockImplementation(async (alias) => {
            if (alias !== SIGNING_KEY_ALIAS) return realHasKey(alias)
            signingReads.push(1)
            return false
        })
        const generate = jest.spyOn(keystore, "generateKey")

        await createDeviceKey({ onInvalidated, sleep })

        expect(signingReads).toHaveLength(3)
        expect(sleep.mock.calls).toEqual([[200], [600]])
        expect(generate).toHaveBeenCalledTimes(2)
    })

    it("does not wait when every alias is present", async () => {
        await createDeviceKey({ onInvalidated, sleep })

        expect(sleep).not.toHaveBeenCalled()
    })
})

describe("replaceDeviceKeys", () => {
    // Stands in for expo-secure-store's own wrapping key, which shares the app's keystore.
    const OTHER_ALIAS = "AES/GCM/NoPadding:SecureStore"
    let keystore: SoftwareKeystore

    beforeEach(() => {
        keystore = new SoftwareKeystore()
        mockNative = keystore
    })

    it("swaps the pair for fresh keys and leaves every other alias in the keystore alone", async () => {
        const before = await (await createDeviceKey(options)).getPublicKeyJwk()
        await keystore.generateKey(OTHER_ALIAS, { purpose: "sign" })
        const other = await keystore.getPublicKey(OTHER_ALIAS)
        const eraseAll = jest.spyOn(keystore, "eraseAll")

        const replaced = await replaceDeviceKeys(options)

        expect(await replaced.getPublicKeyJwk()).not.toEqual(before)
        expect(await keystore.hasKey(AGREEMENT_KEY_ALIAS)).toBe(true)
        expect(await keystore.getPublicKey(OTHER_ALIAS)).toBe(other)
        expect(eraseAll).not.toHaveBeenCalled()
    })

    it("does not re-probe the aliases it just deleted", async () => {
        const sleep = jest.fn(async () => undefined)
        await createDeviceKey(options)

        await replaceDeviceKeys({ onInvalidated, sleep })

        expect(sleep).not.toHaveBeenCalled()
    })

    it("also deletes the one-key build's and the unattested pair's aliases", async () => {
        await keystore.generateKey(LEGACY_DEVICE_KEY_ALIAS, { purpose: "sign" })
        await keystore.generateKey(SIGNING_KEY_ALIAS, { purpose: "sign" })
        await keystore.generateKey(AGREEMENT_KEY_ALIAS, { purpose: "agree" })
        const deleteKey = jest.spyOn(keystore, "deleteKey")

        await replaceDeviceKeys(options)

        expect([...new Set(deleteKey.mock.calls.map(([alias]) => alias))].sort()).toEqual(
            [
                LEGACY_DEVICE_KEY_ALIAS,
                LEGACY_SIGNING_KEY_ALIAS,
                LEGACY_AGREEMENT_KEY_ALIAS,
                SIGNING_KEY_ALIAS,
                AGREEMENT_KEY_ALIAS
            ].sort()
        )
        expect(await keystore.hasKey(LEGACY_DEVICE_KEY_ALIAS)).toBe(false)
    })
})

describe("the device key", () => {
    let keystore: SoftwareKeystore

    beforeEach(() => {
        keystore = new SoftwareKeystore()
        mockNative = keystore
    })

    it("signs with the signing key under the prompt it was given", async () => {
        const deviceKey = await createDeviceKey(options)

        const signature = await deviceKey.signerFor(prompt).signDigest(new Uint8Array(32).fill(1))

        expect(signature).toHaveLength(64)
        expect(keystore.prompts).toEqual([prompt])
    })

    it("does the ECDH on the agreement key", async () => {
        const deviceKey = await createDeviceKey(options)
        // Any valid P-256 point will do as the peer; the signing key's is to hand.
        const peer = base64ToBytes(await keystore.getPublicKey(SIGNING_KEY_ALIAS))

        const secret = await deviceKey.ecdh(peer, prompt)

        expect(secret).toHaveLength(32)
        expect(keystore.prompts).toEqual([prompt])
    })

    it("reports a cancelled prompt as DeviceKeyError USER_CANCELED", async () => {
        const deviceKey = await createDeviceKey(options)
        jest.spyOn(keystore, "signDigest").mockRejectedValue(nativeError("ERR_USER_CANCELED"))

        const failure = await deviceKey
            .signerFor(prompt)
            .signDigest(new Uint8Array(32))
            .catch((error: unknown) => error)

        expect(failure).toBeInstanceOf(DeviceKeyError)
        expect(failure).toMatchObject({ code: "USER_CANCELED" })
        expect(onInvalidated).not.toHaveBeenCalled()
    })

    it("tells the app about an invalidated key before throwing KEY_INVALIDATED", async () => {
        const deviceKey = await createDeviceKey(options)
        jest.spyOn(keystore, "ecdh").mockRejectedValue(nativeError("ERR_KEY_INVALIDATED"))

        const failure = await deviceKey.ecdh(new Uint8Array(65), prompt).catch((error: unknown) => error)

        expect(failure).toMatchObject({ code: "KEY_INVALIDATED" })
        expect(onInvalidated).toHaveBeenCalledTimes(1)
    })

    it("tells the app once per invalidated signature, and throws KEY_INVALIDATED", async () => {
        const deviceKey = await createDeviceKey(options)
        jest.spyOn(keystore, "signDigest").mockRejectedValue(nativeError("ERR_KEY_INVALIDATED"))
        const signer = deviceKey.signerFor(prompt)

        const failure = await signer.signDigest(new Uint8Array(32)).catch((error: unknown) => error)

        expect(failure).toBeInstanceOf(DeviceKeyError)
        expect(failure).toMatchObject({ code: "KEY_INVALIDATED" })
        expect(onInvalidated).toHaveBeenCalledTimes(1)

        await expect(signer.signDigest(new Uint8Array(32))).rejects.toBeInstanceOf(DeviceKeyError)
        expect(onInvalidated).toHaveBeenCalledTimes(2)
    })

    it("throws a DeviceKeyError, not the native error, for an invalidated ecdh", async () => {
        const deviceKey = await createDeviceKey(options)
        jest.spyOn(keystore, "ecdh").mockRejectedValue(nativeError("ERR_KEY_INVALIDATED"))

        await expect(deviceKey.ecdh(new Uint8Array(65), prompt)).rejects.toBeInstanceOf(DeviceKeyError)
    })

    it.each(["ecdh", "sign", "signDigest"] as const)(
        "reports ERR_AUTHENTICATION_FAILED from %s as DeviceKeyError AUTHENTICATION_FAILED, keeping its message",
        async (op) => {
            const deviceKey = await createDeviceKey(options)
            const failure = Object.assign(new Error("7: Too many attempts"), { code: "ERR_AUTHENTICATION_FAILED" })
            jest.spyOn(keystore, op).mockRejectedValue(failure)
            const signer = deviceKey.signerFor(prompt)

            const caught = await (
                op === "ecdh"
                    ? deviceKey.ecdh(new Uint8Array(65), prompt)
                    : op === "sign"
                      ? signer.sign(new Uint8Array(1))
                      : signer.signDigest(new Uint8Array(32))
            ).catch((error: unknown) => error)

            expect(caught).toBeInstanceOf(DeviceKeyError)
            expect(caught).toMatchObject({ code: "AUTHENTICATION_FAILED", message: "7: Too many attempts" })
            expect(onInvalidated).not.toHaveBeenCalled()
        }
    )

    it("never records a prompt for getPublicKeyJwk", async () => {
        const deviceKey = await createDeviceKey(options)

        await deviceKey.getPublicKeyJwk()
        await deviceKey.signerFor(prompt).getPublicKeyJwk()

        expect(keystore.prompts).toEqual([])
    })

    it("rethrows any other failure untouched", async () => {
        const deviceKey = await createDeviceKey(options)
        const failure = nativeError("ERR_SIGNING")
        jest.spyOn(keystore, "sign").mockRejectedValue(failure)

        await expect(deviceKey.signerFor(prompt).sign(new Uint8Array(1))).rejects.toBe(failure)
        expect(onInvalidated).not.toHaveBeenCalled()
    })

    it("reads the attestation chain of the signing key", async () => {
        const deviceKey = await createDeviceKey(options)
        const getAttestationChain = jest.spyOn(keystore, "getAttestationChain").mockResolvedValue(["bGVhZg=="])

        expect(await deviceKey.getAttestationChain()).toEqual(["bGVhZg=="])
        expect(getAttestationChain).toHaveBeenCalledWith(SIGNING_KEY_ALIAS)
    })

    it("reports the lower of the two keys' security levels", async () => {
        const deviceKey = await createDeviceKey(options)
        const levels: Record<string, "STRONGBOX" | "TRUSTED_ENVIRONMENT"> = {
            [SIGNING_KEY_ALIAS]: "STRONGBOX",
            [AGREEMENT_KEY_ALIAS]: "TRUSTED_ENVIRONMENT"
        }
        jest.spyOn(keystore, "getSecurityLevel").mockImplementation(async (alias) => levels[alias])

        expect(await deviceKey.getSecurityLevel()).toBe("TRUSTED_ENVIRONMENT")
    })
})
