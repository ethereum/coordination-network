import { describe, expect, it, jest } from "@jest/globals"
import { deliver } from "../src/flows/deliver"
import type { MemberContext } from "../src/context"
import { config, createFakeLinkClient, createFakePolicy, createFakeServer, networkId, txHash } from "./support"

function buildContext(overrides: Partial<MemberContext> = {}): MemberContext {
    const { client } = createFakeLinkClient({})
    return {
        config,
        link: client,
        server: createFakeServer({ deliver: async () => ({ status: "announced", txHash }) }),
        policy: createFakePolicy(),
        ...overrides
    }
}

describe("deliver", () => {
    it("announces a delivery to the recipient's registered stealth address", async () => {
        const outcome = await deliver(buildContext(), { networkId })

        expect(outcome).toEqual({ status: "announced", networkId, txHash })
    })

    it("calls onDelivered on success and never fails the flow when the hook itself throws", async () => {
        const onError = jest.fn((): void => {})
        const ctx = buildContext({
            hooks: {
                onDelivered: () => {
                    throw new Error("hook boom")
                },
                onError
            }
        })

        const outcome = await deliver(ctx, { networkId })

        expect(outcome).toEqual({ status: "announced", networkId, txHash })
        expect(onError).toHaveBeenCalledWith({ flow: "deliver", stage: "deliveries", error: expect.any(Error) })
    })

    it("reports a failed outcome with stage deliveries when the recipient is not registered", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                deliver: async () => {
                    throw new Error("DELIVERY_REFUSED")
                }
            })
        })

        const outcome = await deliver(ctx, { networkId })

        expect(outcome).toEqual({
            status: "failed",
            stage: "deliveries",
            error: { message: "DELIVERY_REFUSED" }
        })
    })
})
