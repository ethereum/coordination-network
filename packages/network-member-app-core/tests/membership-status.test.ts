import { describe, expect, it } from "@jest/globals"
import { membershipStatus } from "../src/flows/membership-status"
import type { MemberContext } from "../src/context"
import {
    authAddress,
    config,
    createFakeLinkClient,
    createFakePolicy,
    createFakeServer,
    governanceSigner,
    metaStealthAddress,
    networkId,
    safeAddress
} from "./support"

function buildContext(overrides: Partial<MemberContext> = {}): MemberContext {
    const { client } = createFakeLinkClient({})
    return {
        config,
        link: client,
        server: createFakeServer(),
        policy: createFakePolicy(),
        ...overrides
    }
}

describe("membershipStatus", () => {
    it("relays the server's membership snapshot", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                getMembership: async () => ({
                    status: "approved",
                    networkId,
                    authAddress,
                    governanceSigner,
                    metaStealthAddress,
                    safe: { address: safeAddress, threshold: 2, owners: [authAddress] },
                    identityRegistered: true,
                    issuerKeyPublished: true
                })
            })
        })

        const outcome = await membershipStatus(ctx)

        expect(outcome).toEqual({
            status: "approved",
            networkId,
            authAddress,
            safe: { address: safeAddress, threshold: 2, owners: [authAddress] },
            identityRegistered: true,
            issuerKeyPublished: true
        })
    })

    it("reports a failed outcome with stage membershipStatus when the server call throws", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                getMembership: async () => {
                    throw new Error("server unreachable")
                }
            })
        })

        const outcome = await membershipStatus(ctx)

        expect(outcome).toEqual({
            status: "failed",
            stage: "membershipStatus",
            error: { message: "server unreachable" }
        })
    })
})
