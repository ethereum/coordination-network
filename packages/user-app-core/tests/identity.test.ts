import { describe, expect, it } from "@jest/globals"
import { deriveKeys } from "@coordination-network/identity"
import type { SecurityLevel } from "@coordination-network/user-app-link"
import { DEVICE_SECRET_KEY } from "../src/device-secret"
import { createUserAppService } from "../src/service"
import { createServiceHarness } from "./support/harness"

describe("onboarding and the identity behind it", () => {
    it("starts not onboarded, and gates every handler on it", async () => {
        const { service } = createServiceHarness()
        expect(await service.isOnboarded()).toBe(false)

        await expect(
            service.handlers["registration.sign"]!(
                { chainId: 1337, verifyingContract: `0x${"cc".repeat(20)}` },
                { caller: { name: "x", scheme: "x" } }
            )
        ).rejects.toMatchObject({
            code: "NOT_ONBOARDED"
        })
        await expect(service.readIdentity()).rejects.toThrow(/no identity/)
    })

    it("createIdentity provisions exactly one identity and refuses a second", async () => {
        const { service } = createServiceHarness()
        await service.createIdentity()
        expect(await service.isOnboarded()).toBe(true)
        await expect(service.createIdentity()).rejects.toThrow(/already exists/)
    })

    describe("the minimum device security level", () => {
        const floored = (level: SecurityLevel, minimum?: SecurityLevel) => {
            const harness = createServiceHarness()
            harness.deviceKey.getSecurityLevel = async () => level
            return createUserAppService({ ...harness.ports, minimumDeviceSecurityLevel: minimum })
        }

        it.each(["SOFTWARE", "UNKNOWN"] as const)("refuses %s under a TRUSTED_ENVIRONMENT floor", async (level) => {
            const service = floored(level, "TRUSTED_ENVIRONMENT")

            await expect(service.createIdentity()).rejects.toThrow(
                new RegExp(`${level}.*hardware-backed key \\(TRUSTED_ENVIRONMENT or better\\)`)
            )
            expect(await service.isOnboarded()).toBe(false)
        })

        it("accepts STRONGBOX under a TRUSTED_ENVIRONMENT floor", async () => {
            const service = floored("STRONGBOX", "TRUSTED_ENVIRONMENT")

            expect((await service.createIdentity()).securityLevel).toBe("STRONGBOX")
            expect(await service.isOnboarded()).toBe(true)
        })

        it("accepts SOFTWARE when no floor is set", async () => {
            const service = floored("SOFTWARE")

            expect((await service.createIdentity()).securityLevel).toBe("SOFTWARE")
        })

        it("writes nothing when it refuses, and a later createIdentity with a passing level succeeds", async () => {
            const harness = createServiceHarness()
            let level: SecurityLevel = "SOFTWARE"
            harness.deviceKey.getSecurityLevel = async () => level
            const service = createUserAppService({
                ...harness.ports,
                minimumDeviceSecurityLevel: "TRUSTED_ENVIRONMENT"
            })

            await expect(service.createIdentity()).rejects.toThrow(/hardware-backed/)
            expect(await harness.store.list()).toEqual([])
            expect(await harness.store.get(DEVICE_SECRET_KEY)).toBeNull()

            level = "TRUSTED_ENVIRONMENT"
            expect((await service.createIdentity()).securityLevel).toBe("TRUSTED_ENVIRONMENT")
            expect(await service.isOnboarded()).toBe(true)
        })

        it("reads the security level once more than it does without a floor, and only because of the floor", async () => {
            const readsWith = async (minimum?: SecurityLevel) => {
                const harness = createServiceHarness()
                let reads = 0
                harness.deviceKey.getSecurityLevel = async () => {
                    reads += 1
                    return "STRONGBOX"
                }
                await createUserAppService({ ...harness.ports, minimumDeviceSecurityLevel: minimum }).createIdentity()
                return reads
            }

            expect(await readsWith("SOFTWARE")).toBe((await readsWith()) + 1)
        })
    })

    it("leaves isOnboarded false when the device key cannot be read in createIdentity", async () => {
        const { service, deviceKey } = createServiceHarness()
        deviceKey.getSecurityLevel = async () => {
            throw new Error("keystore unavailable")
        }

        await expect(service.createIdentity()).rejects.toThrow(/keystore unavailable/)
        expect(await service.isOnboarded()).toBe(false)
    })

    // The Identity screen reads this through the service. No op hands it over a link: a caller
    // that wants a networkId gets the one inside a signed registration request it asked for.
    it("readIdentity returns what createIdentity provisioned", async () => {
        const { service } = createServiceHarness()
        const created = await service.createIdentity()

        expect(await service.readIdentity()).toEqual(created)
    })

    // The screen shows four values, all of which fall out of the device secret and the keystore's
    // own report. Reading it used to cost a secure-element ECDH and a Baby Jubjub derivation for
    // two fields nothing displayed.
    it("readIdentity needs no hardware ECDH", async () => {
        const { service, deviceKey } = createServiceHarness()
        const created = await service.createIdentity()
        deviceKey.ecdh = async () => {
            throw new Error("the identity screen must not need an ECDH")
        }

        await expect(service.readIdentity()).resolves.toEqual(created)
        expect(Object.keys(created).sort()).toEqual([
            "accountPublicKey",
            "metaStealthAddress",
            "networkId",
            "securityLevel"
        ])
    })

    it("listCredentials is empty before anything is stored", async () => {
        const { service } = createServiceHarness()
        await service.createIdentity()
        expect(await service.listCredentials()).toEqual([])
    })

    it("erase wipes onboarding state and every store key this package or its Wallet ever wrote", async () => {
        const { service, store } = createServiceHarness()
        await service.createIdentity()
        expect(await store.list()).not.toEqual([])

        await service.erase()

        expect(await service.isOnboarded()).toBe(false)
        expect(await store.list()).toEqual([])
    })

    it("readStealthScanKeys hands out only the scanning pair, not the device secret", async () => {
        const { service, store } = createServiceHarness()
        await service.createIdentity()

        const scan = await service.readStealthScanKeys()
        const secret = await store.get("user-app-core:device-secret")
        const expected = deriveKeys(secret as `0x${string}`)

        expect(scan.spendingPublicKey).toBe(expected.spending.publicKey)
        expect(scan.viewingPrivateKey).toBe(expected.viewing.privateKey)
        // The account key is what everything else derives from; scanning must not need it.
        expect(Object.values(scan)).not.toContain(expected.account.privateKey)
    })

    it("readStealthScanKeys refuses before onboarding", async () => {
        const { service } = createServiceHarness()
        await expect(service.readStealthScanKeys()).rejects.toThrow(/no identity/)
    })
})
