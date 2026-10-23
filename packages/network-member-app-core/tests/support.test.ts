import { describe, expect, it } from "@jest/globals"
import { createFakePolicy, createFakeServer, subject } from "./support"

describe("createFakeServer", () => {
    it("throws for any method a test hasn't stubbed", async () => {
        const server = createFakeServer()

        await expect(server.deliver({ networkId: subject.networkId })).rejects.toThrow(
            "fake server: deliver was not stubbed for this test"
        )
    })
})

describe("createFakePolicy", () => {
    it("approves everything by default", async () => {
        const policy = createFakePolicy()

        await expect(policy.decideEnrolment(subject)).resolves.toEqual({ approved: true, value: undefined })
        await expect(policy.decideIssuance(subject)).resolves.toEqual({
            approved: true,
            value: { programme: "demo-programme", country: "ZZZ" }
        })
    })
})
