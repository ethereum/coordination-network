import { describe, it, expect } from "@jest/globals"
import { deriveKeys } from "@coordination-network/identity"
import { onboard, register } from "../src/register"
import { metaStealthAddressFromKeys } from "../src/meta"
import { InMemoryIdentityRegistry } from "../src/registry"
import { InMemoryMemberServer } from "../src/member-server"
import { RegistryReadFailedError, SubmissionFailedError, UserClientError } from "../src/errors"
import {
    ChainDomain,
    Hex,
    RegistrationRequest,
    RegistrationSubmitter,
    RegistryReader,
    SubmissionReceipt
} from "../src/types"

const DEVICE_SECRET: Hex = `0x${"41".repeat(32)}`
const DOMAIN: ChainDomain = {
    chainId: 31337,
    verifyingContract: `0x${"06".repeat(19)}e7`
}

/** Wraps a RegistrationSubmitter and counts calls to submit(). */
class CountingSubmitter implements RegistrationSubmitter {
    calls = 0
    constructor(private readonly delegate: RegistrationSubmitter) {}

    async submit(request: RegistrationRequest): Promise<SubmissionReceipt> {
        this.calls++
        return this.delegate.submit(request)
    }
}

/** Wraps a RegistryReader and counts calls to getIdentity(). */
class CountingRegistryReader implements RegistryReader {
    calls = 0
    constructor(private readonly delegate: RegistryReader) {}

    async getIdentity(networkId: Hex): Promise<Hex | null> {
        this.calls++
        return this.delegate.getIdentity(networkId)
    }
}

describe("onboard", () => {
    it("derives fields internally consistent with deriveKeys + metaStealthAddressFromKeys", () => {
        const result = onboard(DEVICE_SECRET)
        const keys = deriveKeys(DEVICE_SECRET)

        expect(result.metaStealthAddress).toBe(metaStealthAddressFromKeys(keys))
        expect(result.networkId).toBe(keys.networkId)
        expect(result.displayMetaStealthAddress.startsWith("st:eth:")).toBe(true)
    })
})

describe("register", () => {
    it("registers on a fresh registry and returns a JSON-safe request", async () => {
        const { networkId, metaStealthAddress } = onboard(DEVICE_SECRET)
        const registry = new InMemoryIdentityRegistry()

        const result = await register({
            deviceSecret: DEVICE_SECRET,
            registry,
            submitter: new InMemoryMemberServer(registry, DOMAIN),
            domain: DOMAIN
        })

        expect(result.status).toBe("registered")
        if (result.status !== "registered") throw new Error("expected registered")
        expect(result.networkId).toBe(networkId)
        expect(result.metaStealthAddress).toBe(metaStealthAddress)
        expect(JSON.parse(JSON.stringify(result.request))).toEqual(result.request)
        expect(result.receipt.txHash).toBeTruthy()

        await expect(registry.getIdentity(networkId)).resolves.toBe(metaStealthAddress)
    })

    it("is idempotent: a second call with the same inputs returns alreadyRegistered and submits only once", async () => {
        const { networkId, metaStealthAddress } = onboard(DEVICE_SECRET)
        const registry = new InMemoryIdentityRegistry()
        const submitter = new CountingSubmitter(new InMemoryMemberServer(registry, DOMAIN))

        const params = {
            deviceSecret: DEVICE_SECRET,
            registry,
            submitter,
            domain: DOMAIN
        }

        const first = await register(params)
        const second = await register(params)

        expect(first.status).toBe("registered")
        expect(second).toEqual({
            status: "alreadyRegistered",
            networkId,
            metaStealthAddress,
            derivedMetaStealthAddress: metaStealthAddress,
            matchesDerived: true
        })
        expect(submitter.calls).toBe(1)
    })

    it("reads the registry exactly once per call", async () => {
        const registry = new InMemoryIdentityRegistry()
        const countingRegistry = new CountingRegistryReader(registry)

        await register({
            deviceSecret: DEVICE_SECRET,
            registry: countingRegistry,
            submitter: new InMemoryMemberServer(registry, DOMAIN),
            domain: DOMAIN
        })

        expect(countingRegistry.calls).toBe(1)
    })

    it("returns the pre-seeded metaStealthAddress, not the derived one, when the registry already has a different value", async () => {
        const { networkId } = onboard(DEVICE_SECRET)
        const registry = new InMemoryIdentityRegistry()
        const seededMetaStealthAddress: Hex = `0x${"ab".repeat(66)}`
        registry.registerIdentity(networkId, seededMetaStealthAddress)

        const result = await register({
            deviceSecret: DEVICE_SECRET,
            registry,
            submitter: new InMemoryMemberServer(registry, DOMAIN),
            domain: DOMAIN
        })

        expect(result).toEqual({
            status: "alreadyRegistered",
            networkId,
            metaStealthAddress: seededMetaStealthAddress,
            derivedMetaStealthAddress: onboard(DEVICE_SECRET).metaStealthAddress,
            matchesDerived: false
        })
    })

    it("rethrows a SubmissionFailedError from the submitter without rewrapping it", async () => {
        const registry = new InMemoryIdentityRegistry()
        const originalError = new SubmissionFailedError("AlreadyRegistered: lost the race")
        const failingSubmitter: RegistrationSubmitter = {
            async submit(): Promise<SubmissionReceipt> {
                throw originalError
            }
        }

        await expect(
            register({
                deviceSecret: DEVICE_SECRET,
                registry,
                submitter: failingSubmitter,
                domain: DOMAIN
            })
        ).rejects.toBe(originalError)
    })

    it("wraps a plain submission error in SubmissionFailedError, preserving the original as .cause", async () => {
        const registry = new InMemoryIdentityRegistry()
        const originalError = new Error("boom")
        const failingSubmitter: RegistrationSubmitter = {
            async submit(): Promise<SubmissionReceipt> {
                throw originalError
            }
        }

        await expect(
            register({
                deviceSecret: DEVICE_SECRET,
                registry,
                submitter: failingSubmitter,
                domain: DOMAIN
            })
        ).rejects.toMatchObject({
            constructor: SubmissionFailedError,
            cause: originalError
        })
    })

    it("treats a chain reader's empty-bytes answer as unregistered, not as an existing entry", async () => {
        // IdentityRegistry stores `bytes`, so its generated getter answers an unknown networkId with
        // 0x. A reader built straight onto viem or ethers returns that verbatim; reading it as an
        // entry would report success while never registering anything.
        const registry = new InMemoryIdentityRegistry()
        const emptyBytesReader: RegistryReader = {
            async getIdentity() {
                return "0x"
            }
        }

        const result = await register({
            deviceSecret: DEVICE_SECRET,
            registry: emptyBytesReader,
            submitter: new InMemoryMemberServer(registry, DOMAIN),
            domain: DOMAIN
        })

        expect(result.status).toBe("registered")
        await expect(registry.getIdentity(onboard(DEVICE_SECRET).networkId)).resolves.not.toBeNull()
    })

    it("wraps a RegistryReader rejection in RegistryReadFailedError, preserving the original as .cause", async () => {
        const originalError = new Error("rpc timeout")
        const failingReader: RegistryReader = {
            async getIdentity() {
                throw originalError
            }
        }

        let caught: unknown
        try {
            await register({
                deviceSecret: DEVICE_SECRET,
                registry: failingReader,
                submitter: new InMemoryMemberServer(new InMemoryIdentityRegistry(), DOMAIN),
                domain: DOMAIN
            })
        } catch (error) {
            caught = error
        }

        expect(caught).toBeInstanceOf(RegistryReadFailedError)
        expect((caught as RegistryReadFailedError).code).toBe("REGISTRY_READ_FAILED")
        expect((caught as RegistryReadFailedError).cause).toBe(originalError)
        expect(Object.keys(caught as object)).not.toContain("cause")
    })

    it("rejects a reader that answers with something other than a 66-byte entry or null", async () => {
        const registry = new InMemoryIdentityRegistry()
        const truncatingReader: RegistryReader = {
            async getIdentity() {
                return `0x${"ab".repeat(20)}`
            }
        }

        await expect(
            register({
                deviceSecret: DEVICE_SECRET,
                registry: truncatingReader,
                submitter: new InMemoryMemberServer(registry, DOMAIN),
                domain: DOMAIN
            })
        ).rejects.toBeInstanceOf(UserClientError)
    })

    it("flags an existing entry that this device secret no longer derives", async () => {
        const registry = new InMemoryIdentityRegistry()
        const { networkId, metaStealthAddress } = onboard(DEVICE_SECRET)
        registry.registerIdentity(networkId, `0x${"cd".repeat(66)}`)

        const result = await register({
            deviceSecret: DEVICE_SECRET,
            registry,
            submitter: new InMemoryMemberServer(registry, DOMAIN),
            domain: DOMAIN
        })

        if (result.status !== "alreadyRegistered") throw new Error("expected alreadyRegistered")
        expect(result.matchesDerived).toBe(false)
        expect(result.derivedMetaStealthAddress).toBe(metaStealthAddress)
    })
})
