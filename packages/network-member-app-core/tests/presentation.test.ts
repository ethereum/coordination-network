import { expect, it, jest } from "@jest/globals"
import { createMemberFlows } from "../src/context"
import { config, createFakeLinkClient, createFakePolicy, createFakeServer, verificationRecord } from "./support"

function setup(ok = true) {
    const verification = { ...verificationRecord, ok, ...(ok ? {} : { code: "CREDENTIAL_REVOKED" }) }
    const hooks = { onVerified: jest.fn((): void => {}), onError: jest.fn((): void => {}) }
    const server = createFakeServer({
        getPresentationStatus: async () => ({ status: "completed", verification })
    })
    const flows = createMemberFlows({
        config,
        server,
        link: createFakeLinkClient({}).client,
        policy: createFakePolicy(),
        hooks
    })
    return { verification, hooks, server, flows }
}

it.each([true, false])(
    "reports a completed cross-device result once, including concurrent polls (accepted=%s)",
    async (ok) => {
        const { verification, hooks, flows } = setup(ok)
        await Promise.all([
            flows.presentationStatus(verification.requestId),
            flows.presentationStatus(verification.requestId)
        ])
        expect(hooks.onVerified).toHaveBeenCalledTimes(1)
        expect(hooks.onVerified).toHaveBeenCalledWith({
            status: ok ? "verified" : "rejected",
            verificationId: verification.verificationId,
            programme: verification.programme,
            country: verification.country,
            ...(ok ? {} : { code: "CREDENTIAL_REVOKED" })
        })
    }
)

it("reports a failed status lookup through onError", async () => {
    const { flows, hooks, server } = setup()
    server.getPresentationStatus = async () => {
        throw new Error("offline")
    }
    await expect(flows.presentationStatus("request")).rejects.toThrow("offline")
    expect(hooks.onError).toHaveBeenCalledWith(expect.objectContaining({ flow: "verify", stage: "verifications" }))
})

it("reports a failed challenge creation through onError", async () => {
    const { flows, hooks, server } = setup()
    server.createPresentationRequest = async () => {
        throw new Error("offline")
    }
    await expect(flows.startPresentation({ programme: "demo", country: "XAA" })).rejects.toThrow("offline")
    expect(hooks.onError).toHaveBeenCalledWith(
        expect.objectContaining({ flow: "verify", stage: "presentationRequests" })
    )
})

it("rejects a completed result for another request before notifying hooks", async () => {
    const { flows, hooks } = setup()
    await expect(flows.presentationStatus("other-request")).rejects.toThrow(/another request/)
    expect(hooks.onVerified).not.toHaveBeenCalled()
    expect(hooks.onError).toHaveBeenCalledTimes(1)
})

it("reports a throwing business hook without losing the server result or firing it again", async () => {
    const { flows, hooks, verification } = setup()
    hooks.onVerified.mockImplementation(() => {
        throw new Error("business hook failed")
    })
    await expect(flows.presentationStatus(verification.requestId)).resolves.toMatchObject({ status: "completed" })
    await flows.presentationStatus(verification.requestId)
    expect(hooks.onVerified).toHaveBeenCalledTimes(1)
    expect(hooks.onError).toHaveBeenCalledTimes(1)
})
