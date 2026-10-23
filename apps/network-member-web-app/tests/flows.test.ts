import { createMemberFlows, type StackConfig } from "../src/flows"
import { policyForMember } from "../src/business/policy"
import type { LinkClient, LinkOp } from "@coordination-network/user-app-link"

const networkId = `0x${"11".repeat(32)}` as const
const member = {
    name: "alpha",
    networkId,
    serverUrl: "http://alpha.test",
    appOrigin: "http://app.test",
    approved: true,
    memberServerToken: "member-server-token"
}
const stack: StackConfig = {
    chainId: 31338,
    identityRegistry: `0x${"44".repeat(20)}`,
    apps: { user: { origin: "http://user.test" }, relay: { url: "http://relay.test" } },
    members: [member]
}

describe("member flows", () => {
    const hooks = { onEvent: jest.fn() }
    let requests: jest.Mock
    let fetcher: jest.Mock
    let flows: ReturnType<typeof createMemberFlows>
    let values: Map<string, string>
    let options: Parameters<typeof createMemberFlows>[0]
    let verdict: { ok: boolean; code?: string; requestId?: string }

    beforeEach(() => {
        verdict = { ok: true }
        hooks.onEvent.mockClear()
        requests = jest.fn(
            async (op: LinkOp) =>
                ({
                    "registration.sign": {
                        request: {
                            version: "v1",
                            networkId,
                            schemeId: 1,
                            metaStealthAddress: `0x${"22".repeat(66)}`,
                            chainId: 31338,
                            verifyingContract: stack.identityRegistry,
                            signature: `0x${"55".repeat(65)}`
                        },
                        securityLevel: "SOFTWARE"
                    },
                    "credential.issue": { status: "stored", credentialId: "credential-1" },
                    "presentation.create": { verificationId: "verification-1" }
                })[op]
        )
        fetcher = jest.fn(async (url: string) => {
            const body = url.endsWith("/v1/registrations")
                ? { status: "submitted" }
                : url.endsWith("/v1/presentation-requests")
                  ? { requestId: "request-1", challenge: `0x${"77".repeat(31)}`, audience: "urn:alpha", currentTime: 1 }
                  : url.includes("/v1/verifications/")
                    ? { verificationId: "verification-1", requestId: "request-1", ...verdict }
                    : { id: "credential-1", revoked: true }
            return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
        })
        values = new Map()
        options = {
            member,
            stack,
            link: { request: requests } as LinkClient,
            policy: policyForMember(member.name),
            hooks,
            fetcher,
            registrationStore: {
                getItem: (key) => values.get(key) ?? null,
                setItem: (key, value) => {
                    values.set(key, value)
                }
            }
        }
        flows = createMemberFlows(options)
    })

    it("enrols using the current signed-request envelope, without identity.get", async () => {
        expect((await flows.enrol()).result.status).toBe("submitted")
        expect(requests.mock.calls.map(([op]) => op)).toEqual(["registration.sign"])
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({ networkId })
        expect(fetcher.mock.calls[0][1].headers.authorization).toBe("Bearer member-server-token")
    })

    it("lets the wallet drive issuance and exposes only endpoint URLs to it", async () => {
        await flows.enrol()
        fetcher.mockClear()
        await flows.issue()
        expect(requests.mock.calls.map(([op]) => op)).toEqual(["registration.sign", "credential.issue"])
        expect(requests.mock.calls[1][1]).toMatchObject({
            issuerNetworkId: networkId,
            challengeUrl: "http://alpha.test/v1/challenge",
            credentialsUrl: "http://alpha.test/v1/credentials"
        })
        expect(fetcher).not.toHaveBeenCalled()
        expect(flows.state.credentialId).toBe("credential-1")
    })

    it("does not claim success from a wallet response; reads the authenticated server record", async () => {
        const result = await flows.verify()
        expect(result.record.ok).toBe(true)
        expect(fetcher.mock.calls[1][0]).toContain("/v1/verifications/verification-1")
        expect(fetcher.mock.calls[1][1].headers.authorization).toBe("Bearer member-server-token")
    })

    it("rejects a failed server verdict even when the wallet supplies a verification id", async () => {
        verdict = { ok: false, code: "INVALID_PROOF" }
        await expect(flows.verify()).rejects.toThrow("INVALID_PROOF")
        expect(hooks.onEvent).not.toHaveBeenCalledWith("verification", expect.anything())
    })

    it("rejects an accepted record from a different presentation request", async () => {
        verdict = { ok: true, requestId: "previous-request" }
        await expect(flows.verify()).rejects.toThrow("another request")
        expect(hooks.onEvent).not.toHaveBeenCalledWith("verification", expect.anything())
    })

    it("keeps issuer refusals out of the issued state", async () => {
        await flows.enrol()
        requests.mockResolvedValue({ status: "refused", code: "SUBJECT_NOT_ELIGIBLE", message: "issuance refused" })
        await expect(flows.issue()).rejects.toThrow("issuance refused")
        expect(flows.state.credentialId).toBeUndefined()
    })

    it("revokes the credential id the wallet stored", async () => {
        await flows.enrol()
        await flows.issue()
        await flows.revoke()
        expect(fetcher.mock.calls[1][0]).toContain("/credentials/credential-1/revoke")
    })

    it("keeps a successful registration in this tab so issuance works after reload", async () => {
        await flows.enrol()
        requests.mockClear()
        fetcher.mockClear()
        const reloaded = createMemberFlows(options)
        await expect(reloaded.issue()).resolves.toEqual({ id: "credential-1" })
        expect(requests.mock.calls.map(([op]) => op)).toEqual(["credential.issue"])
        expect(fetcher).not.toHaveBeenCalled()
    })

    it.each(["chain", "registry", "member", "server"])("does not reuse registration for another %s", async (field) => {
        await flows.enrol()
        const other = createMemberFlows({
            ...options,
            stack: {
                ...stack,
                chainId: field === "chain" ? 1 : stack.chainId,
                identityRegistry: field === "registry" ? `0x${"bb".repeat(20)}` : stack.identityRegistry
            },
            member: {
                ...member,
                networkId: field === "member" ? `0x${"bb".repeat(32)}` : member.networkId,
                serverUrl: field === "server" ? "http://other.test" : member.serverUrl
            }
        })
        expect(other.state.identity).toBeUndefined()
        await expect(other.issue()).rejects.toThrow("register a wallet")
    })

    it.each(["json", "chain", "registry"])("ignores saved registration with invalid %s", async (field) => {
        await flows.enrol()
        const [key, raw] = [...values][0]
        values.set(
            key,
            field === "json"
                ? "{"
                : JSON.stringify({
                      ...JSON.parse(raw),
                      ...(field === "chain" ? { chainId: 1 } : { verifyingContract: `0x${"bb".repeat(20)}` })
                  })
        )
        expect(createMemberFlows(options).state.identity).toBeUndefined()
    })

    it("does not save a registration rejected by the member server", async () => {
        fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: "registration refused" }), { status: 403 }))
        await expect(flows.enrol()).rejects.toThrow("registration refused")
        expect(values.size).toBe(0)
        expect(flows.state.identity).toBeUndefined()
    })

    it("keeps registration usable when tab storage is unavailable", async () => {
        const unavailable = () => {
            throw new Error("storage disabled")
        }
        const current = createMemberFlows({
            ...options,
            registrationStore: { getItem: unavailable, setItem: unavailable }
        })
        await expect(current.enrol()).resolves.toMatchObject({ result: { status: "submitted" } })
        await expect(current.issue()).resolves.toEqual({ id: "credential-1" })
    })
})
