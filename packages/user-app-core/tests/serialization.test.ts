import { describe, expect, it } from "@jest/globals"
import { createServiceHarness } from "./support/harness"

const CALLER = { name: "test-member", scheme: "testmember" }
const REGISTRATION = { chainId: 1337, verifyingContract: `0x${"cc".repeat(20)}` as const }

/** Stands in for the slow part of a handler body: called inside it, on every dispatch. */
function delayedSecurityLevel(harness: ReturnType<typeof createServiceHarness>, onCall: () => void): void {
    const original = harness.deviceKey.getSecurityLevel.bind(harness.deviceKey)
    harness.deviceKey.getSecurityLevel = async () => {
        onCall()
        await new Promise((resolve) => setTimeout(resolve, 10))
        return original()
    }
}

describe("handler serialization", () => {
    it("never runs two handler bodies concurrently, even when dispatched at the same time", async () => {
        const harness = createServiceHarness()
        await harness.service.createIdentity()

        let inFlight = 0
        let maxInFlight = 0
        const original = harness.deviceKey.getSecurityLevel.bind(harness.deviceKey)
        harness.deviceKey.getSecurityLevel = async () => {
            inFlight += 1
            maxInFlight = Math.max(maxInFlight, inFlight)
            await new Promise((resolve) => setTimeout(resolve, 10))
            inFlight -= 1
            return original()
        }

        await Promise.all([
            harness.service.handlers["registration.sign"]!(REGISTRATION, { caller: CALLER }),
            harness.service.handlers["registration.sign"]!(REGISTRATION, { caller: CALLER }),
            harness.service.handlers["registration.sign"]!(REGISTRATION, { caller: CALLER })
        ])

        expect(maxInFlight).toBe(1)
    })

    it("erase does not resolve until an in-flight handler body completes", async () => {
        const harness = createServiceHarness()
        await harness.service.createIdentity()

        const order: string[] = []
        delayedSecurityLevel(harness, () => order.push("handler-start"))

        const handlerPromise = harness.service.handlers["registration.sign"]!(REGISTRATION, { caller: CALLER }).then(
            () => order.push("handler-end")
        )
        const erasePromise = harness.service.erase().then(() => order.push("erase-done"))

        await Promise.all([handlerPromise, erasePromise])

        expect(order).toEqual(["handler-start", "handler-end", "erase-done"])
    })

    it("a rejected handler does not block the next one from running", async () => {
        const harness = createServiceHarness()

        // Not onboarded: the first call rejects with NOT_ONBOARDED.
        const first = harness.service.handlers["registration.sign"]!(REGISTRATION, { caller: CALLER })
        await expect(first).rejects.toMatchObject({ code: "NOT_ONBOARDED" })

        await harness.service.createIdentity()
        await expect(
            harness.service.handlers["registration.sign"]!(REGISTRATION, { caller: CALLER })
        ).resolves.toMatchObject({ request: { networkId: expect.any(String) } })
    })
})
