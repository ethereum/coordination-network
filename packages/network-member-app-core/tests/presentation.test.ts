import { expect, it, jest } from "@jest/globals"
import { decodePresentationQr } from "@coordination-network/user-app-link"
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

it("does not notify hooks for a status that is not completed", async () => {
    const { flows, hooks, server } = setup()
    server.getPresentationStatus = async () => ({ status: "pending" })
    await expect(flows.presentationStatus("request")).resolves.toEqual({ status: "pending" })
    expect(hooks.onVerified).not.toHaveBeenCalled()
    expect(hooks.onError).not.toHaveBeenCalled()
})

it.each([200, 409] as const)("cancels a presentation request through the server (%s)", async (result) => {
    const { flows, server } = setup()
    const cancel = jest.fn<(requestId: string) => Promise<200 | 409>>(async () => result)
    server.cancelPresentationRequest = cancel
    await expect(flows.cancelPresentation("request")).resolves.toBe(result)
    expect(cancel).toHaveBeenCalledWith("request")
})

it("lets a failed cancellation reach the caller", async () => {
    const { flows, server } = setup()
    server.cancelPresentationRequest = async () => {
        throw new Error("offline")
    }
    await expect(flows.cancelPresentation("request")).rejects.toThrow("offline")
})

it("starts a presentation and encodes only the public challenge into the QR", async () => {
    const { flows, server } = setup()
    const record = {
        requestId: "urn:uuid:req-1",
        challenge: `0x${"9c".repeat(31)}` as const,
        audience: "urn:cn:network:member-server",
        currentTime: 1_700_000_000,
        programme: "demo-programme",
        country: "ZZZ",
        expiresAt: 1_700_000_300
    }
    const create = jest.fn<(input: { programme: string; country: string }) => Promise<typeof record>>(
        async () => record
    )
    server.createPresentationRequest = create

    const challenge = await flows.startPresentation({ programme: "demo-programme", country: "ZZZ" })

    expect(create).toHaveBeenCalledWith({ programme: "demo-programme", country: "ZZZ" })
    expect(challenge).toMatchObject({ requestId: record.requestId, expiresAt: record.expiresAt })
    expect(decodePresentationQr(challenge.qr)).toEqual({
        expiresAt: record.expiresAt,
        params: {
            requestId: record.requestId,
            challenge: record.challenge,
            audience: record.audience,
            currentTime: record.currentTime,
            programme: record.programme,
            country: record.country,
            issuersUrl: "https://issuer.example/v1/issuers",
            revocationsUrl: "https://issuer.example/v1/revocations/snapshot",
            responseUrl: "https://issuer.example/v1/verify"
        }
    })
})
