import assert from "node:assert/strict"
import { test } from "node:test"
import { Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import type { GovernancePorts } from "../src/governance-ports"
import { GOVERNANCE_ROUTES } from "../src/routes/governance"
import { buildServer } from "../src/server"

const ISSUER_ID = `0x${"ab".repeat(32)}` as Hex32
const TOKEN = "a-member-server-token-long-enough"

function fakeGovernancePorts(): GovernancePorts {
    return {
        networkId: ISSUER_ID,
        authAddress: `0x${"11".repeat(20)}`,
        governanceSigner: `0x${"22".repeat(20)}`,
        safeAddress: `0x${"33".repeat(20)}`,
        metaStealthAddress: `0x${"55".repeat(66)}`,
        isApproved: async () => false,
        joinRequestFor: async () => null,
        safeState: async () => ({ owners: [`0x${"11".repeat(20)}`], threshold: 1 }),
        identityOf: async () => null,
        issuerKeysOf: async () => [],
        requestToJoin: async () => {
            throw new Error("requestToJoin should not be reached")
        },
        pendingJoinRequests: async () => [],
        admitMember: async () => {
            throw new Error("admitMember should not be reached")
        },
        registerIdentity: async () => {
            throw new Error("registerIdentity should not be reached")
        },
        publishIssuerKey: async () => {
            throw new Error("publishIssuerKey should not be reached")
        }
    }
}

async function serve(
    memberServerToken?: string,
    limits: {
        challengesPerMinute?: number
        issuancesPerMinute?: number
        registrationsPerMinute?: number
        deliveriesPerMinute?: number
        revocationsPerMinute?: number
    } = {}
) {
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer: new LocalCredentialSigner("issuer-service-auth-unit"),
        resolver,
        governance: fakeGovernancePorts(),
        memberServerToken,
        ...limits
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    return { base: `http://127.0.0.1:${port}`, close: () => listener.close() }
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` })

test("without a token configured, a member-side route answers anyone", async () => {
    const { base, close } = await serve()
    try {
        assert.equal((await fetch(`${base}${GOVERNANCE_ROUTES.membership}`)).status, 200)
        assert.equal((await fetch(`${base}/v1/credentials`)).status, 200)
    } finally {
        close()
    }
})

test("with a token configured, a member-side route answers 401 until the right one arrives", async () => {
    const { base, close } = await serve(TOKEN)
    try {
        const refused = [
            {},
            bearer("not-the-token"),
            // Same length as the real one, so the comparison itself is what rejects it.
            bearer("a-member-server-token-long-enougH"),
            { authorization: TOKEN },
            { authorization: `Basic ${TOKEN}` }
        ]
        for (const headers of refused) {
            const res = await fetch(`${base}${GOVERNANCE_ROUTES.membership}`, { headers })
            assert.equal(res.status, 401)
            assert.deepEqual(await res.json(), { error: "member server token required", code: "UNAUTHORIZED" })
        }

        assert.equal((await fetch(`${base}${GOVERNANCE_ROUTES.membership}`, { headers: bearer(TOKEN) })).status, 200)
    } finally {
        close()
    }
})

// The listing and issuance share a path and differ only by method, so a guard mounted on the path
// would shut the wallet out of issuance. This is the assertion that catches that.
test("the credential listing is a member-side route, while issuing on the same path is not", async () => {
    const { base, close } = await serve(TOKEN)
    try {
        assert.equal((await fetch(`${base}/v1/credentials`)).status, 401)
        assert.equal((await fetch(`${base}/v1/credentials`, { headers: bearer(TOKEN) })).status, 200)

        // 400 rather than 401: the guard let it through and the route rejected the empty body.
        const issue = await fetch(`${base}/v1/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: "{}"
        })
        assert.equal(issue.status, 400)
    } finally {
        close()
    }
})

test("the revoke route is a member-side route, and the wallet's own routes stay open", async () => {
    const { base, close } = await serve(TOKEN)
    try {
        const revoke = await fetch(`${base}/v1/credentials/urn:uuid:nope/revoke`, { method: "POST" })
        assert.equal(revoke.status, 401)

        // With the token it reaches the route, which has no such credential to revoke.
        const withToken = await fetch(`${base}/v1/credentials/urn:uuid:nope/revoke`, {
            method: "POST",
            headers: bearer(TOKEN)
        })
        assert.equal(withToken.status, 404)

        for (const path of ["/health", "/v1/issuers", "/v1/revocations/snapshot", "/v1/status", "/v1/activity"]) {
            assert.equal((await fetch(`${base}${path}`)).status, 200, path)
        }
    } finally {
        close()
    }
})

test("verification records require the member server token", async () => {
    const configured = await serve(TOKEN)
    try {
        assert.equal((await fetch(`${configured.base}/v1/verifications/urn:uuid:nope`)).status, 401)
        assert.equal(
            (
                await fetch(`${configured.base}/v1/verifications/urn:uuid:nope`, {
                    headers: bearer(TOKEN)
                })
            ).status,
            404
        )
    } finally {
        configured.close()
    }
})

test("the status page carries no token, with or without one configured, and neither does GET /v1/status", async () => {
    for (const token of [undefined, TOKEN]) {
        const { base, close } = await serve(token)
        try {
            const page = await (await fetch(`${base}/`)).text()
            assert.ok(!page.includes(TOKEN))
            assert.ok(page.includes('data-action="request-to-join"'))
            assert.doesNotMatch(page, /Bearer [^"\s]/)

            const status = await (await fetch(`${base}/v1/status`)).text()
            assert.ok(!status.includes(TOKEN))
        } finally {
            close()
        }
    }
})

const post = (base: string, path: string, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" })

test("registrations and deliveries answer 401 with no token, and reach the route (503 NOT_CONFIGURED) with it", async () => {
    const { base, close } = await serve(TOKEN)
    try {
        assert.equal((await post(base, "/v1/registrations")).status, 401)
        const registered = await post(base, "/v1/registrations", bearer(TOKEN))
        assert.equal(registered.status, 503)
        assert.deepEqual(await registered.json(), { error: "registration not configured", code: "NOT_CONFIGURED" })

        assert.equal((await post(base, "/v1/deliveries")).status, 401)
        const delivered = await post(base, "/v1/deliveries", bearer(TOKEN))
        assert.equal(delivered.status, 503)
        assert.deepEqual(await delivered.json(), { error: "deliveries not configured", code: "NOT_CONFIGURED" })
    } finally {
        close()
    }
})

// The gate runs first: a tokenless flood must not spend the limiter's own budget, only an
// authenticated one can.
test("the member server token gate runs before the rate limit on registrations", async () => {
    const { base, close } = await serve(TOKEN, { registrationsPerMinute: 1 })
    try {
        for (let i = 0; i < 3; i++) {
            assert.equal((await post(base, "/v1/registrations")).status, 401)
        }
        assert.equal((await post(base, "/v1/registrations", bearer(TOKEN))).status, 503)
        assert.equal((await post(base, "/v1/registrations", bearer(TOKEN))).status, 429)
    } finally {
        close()
    }
})

test("the member server token gate runs before the rate limit on deliveries", async () => {
    const { base, close } = await serve(TOKEN, { deliveriesPerMinute: 1 })
    try {
        for (let i = 0; i < 3; i++) {
            assert.equal((await post(base, "/v1/deliveries")).status, 401)
        }
        assert.equal((await post(base, "/v1/deliveries", bearer(TOKEN))).status, 503)
        assert.equal((await post(base, "/v1/deliveries", bearer(TOKEN))).status, 429)
    } finally {
        close()
    }
})

test("the member server token gate runs before the rate limit on revocations", async () => {
    const { base, close } = await serve(TOKEN, { revocationsPerMinute: 1 })
    const revoke = (headers: Record<string, string> = {}) => post(base, "/v1/credentials/urn:uuid:nope/revoke", headers)
    try {
        for (let i = 0; i < 3; i++) {
            assert.equal((await revoke()).status, 401)
        }
        assert.equal((await revoke(bearer(TOKEN))).status, 404)
        assert.equal((await revoke(bearer(TOKEN))).status, 429)
    } finally {
        close()
    }
})

test("the revoke rate limit does not reach other member-side routes", async () => {
    const { base, close } = await serve(TOKEN, { revocationsPerMinute: 1 })
    const revoke = () => post(base, "/v1/credentials/urn:uuid:nope/revoke", bearer(TOKEN))
    try {
        assert.equal((await revoke()).status, 404)
        assert.equal((await revoke()).status, 429)

        const listing = await fetch(`${base}/v1/credentials/x`, { headers: bearer(TOKEN) })
        assert.notEqual(listing.status, 429)
        assert.notEqual((await post(base, "/v1/credentials", bearer(TOKEN))).status, 429)
        assert.notEqual((await post(base, "/v1/deliveries", bearer(TOKEN))).status, 429)
    } finally {
        close()
    }
})

test("deliveries and revocations keep independent rate-limit budgets, so a leaked token spends both", async () => {
    const { base, close } = await serve(TOKEN, { deliveriesPerMinute: 1, revocationsPerMinute: 1 })
    const revoke = () => post(base, "/v1/credentials/urn:uuid:nope/revoke", bearer(TOKEN))
    try {
        assert.equal((await post(base, "/v1/deliveries", bearer(TOKEN))).status, 503)
        assert.equal((await post(base, "/v1/deliveries", bearer(TOKEN))).status, 429)
        assert.equal((await revoke()).status, 404)
        assert.equal((await revoke()).status, 429)
    } finally {
        close()
    }
})

test("registrations and deliveries keep independent rate-limit budgets", async () => {
    const { base, close } = await serve(TOKEN, { registrationsPerMinute: 1, deliveriesPerMinute: 1 })
    try {
        assert.equal((await post(base, "/v1/registrations", bearer(TOKEN))).status, 503)
        assert.equal((await post(base, "/v1/registrations", bearer(TOKEN))).status, 429)
        assert.equal((await post(base, "/v1/deliveries", bearer(TOKEN))).status, 503)
    } finally {
        close()
    }
})

// requireMemberServerToken lets everyone through when no token is configured; the rate limit still runs
// after it and bounds an unauthenticated flood on its own.
test("the rate limit still applies when no member server token is configured", async () => {
    const { base, close } = await serve(undefined, { registrationsPerMinute: 1 })
    try {
        assert.equal((await post(base, "/v1/registrations")).status, 503)
        assert.equal((await post(base, "/v1/registrations")).status, 429)
    } finally {
        close()
    }
})

test("the public challenge route has its own rate limit", async () => {
    const { base, close } = await serve(undefined, { challengesPerMinute: 1 })
    const body = JSON.stringify({ subjectNetworkId: ISSUER_ID })
    try {
        const first = await fetch(`${base}/v1/challenge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body
        })
        assert.equal(first.status, 200)
        const second = await fetch(`${base}/v1/challenge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body
        })
        assert.equal(second.status, 429)
    } finally {
        close()
    }
})

test("the public credential-issuance route bounds proof-validation attempts", async () => {
    const { base, close } = await serve(undefined, { issuancesPerMinute: 1 })
    try {
        assert.equal((await post(base, "/v1/credentials")).status, 400)
        assert.equal((await post(base, "/v1/credentials")).status, 429)
    } finally {
        close()
    }
})
