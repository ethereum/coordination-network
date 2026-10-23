import assert from "node:assert/strict"
import { test } from "node:test"
import { InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import { buildServer } from "../src/server"
import type { AdmissionStatus } from "../src/types"

const ISSUER_ID = `0x${"ab".repeat(32)}` as const
const MEMBER_SERVER_TOKEN = "a-member-server-token-long-enough"
const headers = { authorization: `Bearer ${MEMBER_SERVER_TOKEN}` }

test("serves membership actions and the authoritative issuer root", async (t) => {
    let state: AdmissionStatus = {
        candidateName: "eve",
        profileUrl: "https://example.invalid/eve/membership.json",
        state: "not-requested",
        approvals: [],
        threshold: 2,
        canRequest: true,
        canApprove: false,
        canLeave: false,
        hasApproved: false,
        issuerRoot: "123",
        earlyCompletionBlocked: false,
        outdatedDecisionBlocked: false
    }
    const signer = new LocalCredentialSigner("admission-route-test")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        memberServerToken: MEMBER_SERVER_TOKEN,
        admission: {
            status: async () => state,
            request: async () => {
                state = { ...state, state: "pending", canRequest: false }
                return state
            },
            approve: async () => {
                state = { ...state, approvals: ["alpha"], canApprove: false, hasApproved: true }
                return state
            },
            leave: async () => {
                state = { ...state, state: "departed", canLeave: false }
                return state
            }
        }
    })
    const listener = app.listen(0)
    t.after(() => listener.close())
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`

    for (const path of ["", "/request", "/approve", "/leave"]) {
        const method = path === "" ? "GET" : "POST"
        for (const requestHeaders of [undefined, { authorization: "Bearer wrong-token" }]) {
            const response = await fetch(`${base}/v1/admission${path}`, { method, headers: requestHeaders })
            assert.equal(response.status, 401, `${method} ${path || "/v1/admission"}`)
        }
    }
    assert.equal(state.state, "not-requested")
    assert.deepEqual(state.approvals, [])
    assert.equal(
        ((await (await fetch(`${base}/v1/admission`, { headers })).json()) as AdmissionStatus).state,
        "not-requested"
    )
    assert.equal(
        ((await (await fetch(`${base}/v1/admission/request`, { method: "POST", headers })).json()) as AdmissionStatus)
            .state,
        "pending"
    )
    assert.deepEqual(
        ((await (await fetch(`${base}/v1/admission/approve`, { method: "POST", headers })).json()) as AdmissionStatus)
            .approvals,
        ["alpha"]
    )
    assert.equal(
        ((await (await fetch(`${base}/v1/admission/leave`, { method: "POST", headers })).json()) as AdmissionStatus)
            .state,
        "departed"
    )
    const issuers = (await (await fetch(`${base}/v1/issuers`)).json()) as { root: string }
    assert.match(issuers.root, /^\d+$/)
})

test("admission routes cannot be enabled without a member server token", () => {
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    assert.throws(
        () =>
            buildServer({
                issuerNetworkId: ISSUER_ID,
                signer: new LocalCredentialSigner("admission-without-token"),
                resolver,
                admission: {
                    status: async () => {
                        throw new Error("unreachable")
                    },
                    request: async () => {
                        throw new Error("unreachable")
                    },
                    approve: async () => {
                        throw new Error("unreachable")
                    },
                    leave: async () => {
                        throw new Error("unreachable")
                    }
                }
            }),
        /MEMBER_SERVER_TOKEN is required when admission routes are enabled/
    )
})
