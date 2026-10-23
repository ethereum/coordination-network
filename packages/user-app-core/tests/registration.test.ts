import { describe, expect, it } from "@jest/globals"
import { verifyRegistrationRequest } from "@coordination-network/user-client"
import { createServiceHarness } from "./support/harness"

const CALLER = { name: "member", scheme: "member" }

describe("registration.sign", () => {
    const domain = { chainId: 1337, verifyingContract: `0x${"cc".repeat(20)}` as const }

    it("produces a request that verifies against the same domain", async () => {
        const { service } = createServiceHarness()
        const identity = await service.createIdentity()

        const result = await service.handlers["registration.sign"]!(domain, { caller: CALLER })

        expect(result.request.networkId).toBe(identity.networkId)
        expect(verifyRegistrationRequest(result.request, domain)).toBe(true)
    })

    // The member server has no other way to learn how this phone guards its keys, and it is the
    // one thing the signed request itself does not carry.
    it("names the device's security level alongside the request", async () => {
        const { service, deviceKey } = createServiceHarness()
        await service.createIdentity()
        deviceKey.getSecurityLevel = async () => "STRONGBOX"

        const result = await service.handlers["registration.sign"]!(domain, { caller: CALLER })

        expect(result.securityLevel).toBe("STRONGBOX")
    })

    it("fails verification against a different chain domain", async () => {
        const { service } = createServiceHarness()
        await service.createIdentity()

        const result = await service.handlers["registration.sign"]!(domain, { caller: CALLER })

        expect(
            verifyRegistrationRequest(result.request, { chainId: 999, verifyingContract: domain.verifyingContract })
        ).toBe(false)
    })

    it("requires onboarding", async () => {
        const { service } = createServiceHarness()

        await expect(service.handlers["registration.sign"]!(domain, { caller: CALLER })).rejects.toMatchObject({
            code: "NOT_ONBOARDED"
        })
    })
})
