import { encodePresentationQr, LinkError } from "@coordination-network/user-app-link"
import { trustedPresentation, presentScannedQr } from "../presentation"
import { testMember, testStack } from "../test-stack"
import type { UserAppService } from "@coordination-network/user-app-core"

const member = testMember()
const now = Math.floor(Date.now() / 1000)
const value = {
    expiresAt: now + 300,
    params: {
        requestId: "urn:uuid:request",
        challenge: `0x${"aa".repeat(31)}` as const,
        audience: member.networkId,
        currentTime: now,
        programme: "demo-programme",
        country: "ZZZ",
        issuersUrl: `${member.serverUrl}/v1/issuers`,
        revocationsUrl: `${member.serverUrl}/v1/revocations/snapshot`,
        responseUrl: `${member.serverUrl}/v1/verify`
    }
}
const raw = () => encodePresentationQr(value)
const stack = testStack([member])

it("pins the scanned verifier to configured endpoints and supplies its name for consent", () => {
    const { request, params, serverUrl } = trustedPresentation(raw(), stack)
    expect(request.caller.name).toBe(member.name)
    expect(request.params).toEqual(value.params)
    expect(params).toEqual(value.params)
    expect(serverUrl).toBe(member.serverUrl)
})
it.each([
    null,
    testStack([]),
    testStack([testMember({ serverUrl: "https://wrong.example" })]),
    testStack([testMember({ networkId: `0x${"bb".repeat(32)}` })])
])("rejects unknown verifier/configuration before consent or network access", (configured) => {
    expect(() => trustedPresentation(raw(), configured)).toThrow("not in your configured network")
})
it("rejects expired requests and future timestamps", () => {
    expect(() => trustedPresentation(raw(), stack, (value.expiresAt + 1) * 1000)).toThrow("expired")
    expect(() => trustedPresentation(raw(), stack, (now - 301) * 1000)).toThrow("out of date")
})
it("rejects a noncanonical server path after the QR has been successfully encoded", () => {
    const base = `${member.serverUrl}/other`
    const encoded = encodePresentationQr({
        ...value,
        params: {
            ...value.params,
            responseUrl: `${base}/v1/verify`,
            issuersUrl: `${base}/v1/issuers`,
            revocationsUrl: `${base}/v1/revocations/snapshot`
        }
    })
    expect(() => trustedPresentation(encoded, stack)).toThrow("not in your configured network")
})
it("denied consent never invokes the presentation handler", async () => {
    const handler = jest.fn()
    const service = {
        consent: jest.fn(async () => false),
        handlers: { "presentation.create": handler }
    } as unknown as UserAppService
    await expect(presentScannedQr(raw(), stack, service, jest.fn())).rejects.toThrow("not shared")
    expect(handler).not.toHaveBeenCalled()
})

it("reports an unavailable presentation handler before asking for consent", async () => {
    const consent = jest.fn(async () => true)
    const service = { consent, handlers: {} } as unknown as UserAppService
    await expect(presentScannedQr(raw(), stack, service, jest.fn())).rejects.toMatchObject({ code: "UNSUPPORTED_OP" })
    expect(consent).not.toHaveBeenCalled()
})
it("submits after consent and clears working state on success or failure without a callback", async () => {
    for (const fail of [false, true]) {
        const handler = jest.fn(async () => {
            if (fail) throw new Error("offline")
            return { verificationId: "result" }
        })
        const service = {
            consent: jest.fn(async () => true),
            handlers: { "presentation.create": handler }
        } as unknown as UserAppService
        const working = jest.fn()
        const task = presentScannedQr(raw(), stack, service, working)
        expect(await task.catch((error) => ({ error: error.message }))).toEqual(
            fail ? { error: "offline" } : { verificationId: "result" }
        )
        expect(working.mock.calls).toEqual([["presentation.create"], [null]])
        expect(handler).toHaveBeenCalledTimes(1)
    }
})

it.each(["NO_CREDENTIAL", "CREDENTIAL_REVOKED", "CONSENT_DENIED", "CHAIN_UNREACHABLE"] as const)(
    "reports only a consented credential refusal to the verifier: %s",
    async (code) => {
        const service = {
            consent: async () => true,
            handlers: {
                "presentation.create": async () => {
                    throw new LinkError(code, "Not shared")
                }
            }
        } as unknown as UserAppService
        const postJson = jest.fn(async () => ({ status: 200, body: { verificationId: "refusal" } }))
        await expect(presentScannedQr(raw(), stack, service, jest.fn(), { postJson })).rejects.toThrow("Not shared")
        expect(postJson).toHaveBeenCalledTimes(code === "NO_CREDENTIAL" || code === "CREDENTIAL_REVOKED" ? 1 : 0)
    }
)

it("does not prove a challenge that expires while the consent sheet is open", async () => {
    let approve!: (answer: boolean) => void
    const handler = jest.fn()
    const service = {
        consent: () =>
            new Promise<boolean>((resolve) => {
                approve = resolve
            }),
        handlers: { "presentation.create": handler }
    } as unknown as UserAppService
    const task = presentScannedQr(raw(), stack, service, jest.fn())
    const clock = jest.spyOn(Date, "now").mockReturnValue((value.expiresAt + 1) * 1000)
    approve(true)
    await expect(task).rejects.toThrow("expired")
    expect(handler).not.toHaveBeenCalled()
    clock.mockRestore()
})
