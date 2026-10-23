import { describe, expect, it, jest } from "@jest/globals"
import { revoke } from "../src/flows/revoke"
import type { MemberContext } from "../src/context"
import { config, createFakeLinkClient, createFakePolicy, createFakeServer } from "./support"

function buildContext(overrides: Partial<MemberContext> = {}): MemberContext {
    const { client } = createFakeLinkClient({})
    return {
        config,
        link: client,
        server: createFakeServer({ revokeCredential: async () => ({ id: "urn:uuid:cred-1", revoked: true }) }),
        policy: createFakePolicy(),
        ...overrides
    }
}

describe("revoke", () => {
    it("revokes a credential", async () => {
        const outcome = await revoke(buildContext(), { credentialId: "urn:uuid:cred-1" })

        expect(outcome).toEqual({ status: "revoked", credentialId: "urn:uuid:cred-1" })
    })

    it("calls onRevoked on success and never fails the flow when the hook itself throws", async () => {
        const onError = jest.fn((): void => {})
        const ctx = buildContext({
            hooks: {
                onRevoked: () => {
                    throw new Error("hook boom")
                },
                onError
            }
        })

        const outcome = await revoke(ctx, { credentialId: "urn:uuid:cred-1" })

        expect(outcome).toEqual({ status: "revoked", credentialId: "urn:uuid:cred-1" })
        expect(onError).toHaveBeenCalledWith({ flow: "revoke", stage: "revoke", error: expect.any(Error) })
    })

    it("reports a failed outcome with stage revoke for an unknown credential", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                revokeCredential: async () => {
                    throw new Error("unknown credential")
                }
            })
        })

        const outcome = await revoke(ctx, { credentialId: "urn:uuid:missing" })

        expect(outcome).toEqual({ status: "failed", stage: "revoke", error: { message: "unknown credential" } })
    })

    it("normalizes a non-Error throw to a string message", async () => {
        const ctx = buildContext({
            server: createFakeServer({
                revokeCredential: async () => {
                    throw "server on fire"
                }
            })
        })

        const outcome = await revoke(ctx, { credentialId: "urn:uuid:cred-1" })

        expect(outcome).toEqual({ status: "failed", stage: "revoke", error: { message: "server on fire" } })
    })
})
