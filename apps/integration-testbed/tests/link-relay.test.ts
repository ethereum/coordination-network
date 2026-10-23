import assert from "node:assert/strict"
import { request as httpRequest } from "node:http"
import { test, type TestContext } from "node:test"
import { startLinkRelay, type LinkRelayOptions } from "../src/link-relay"

const token = "a".repeat(64)
const headers = { authorization: `Bearer ${token}` }
const jsonHeaders = { ...headers, "content-type": "application/json" }

async function relay(t: TestContext, options: Partial<LinkRelayOptions> = {}) {
    const server = await startLinkRelay(0, ["http://localhost:4173"], { token, ...options })
    t.after(() => {
        server.close()
        server.closeAllConnections()
    })
    const { port, address } = server.address() as { port: number; address: string }
    return {
        base: `http://127.0.0.1:${port}`,
        address,
        post: (kind: string, sender = "member-tab", url = "userapp://request", consumer?: string) =>
            fetch(`http://127.0.0.1:${port}/v1/${kind}`, {
                method: "POST",
                headers: jsonHeaders,
                body: JSON.stringify({ sender, url, consumer })
            }),
        get: async (path: string) =>
            (await fetch(`http://127.0.0.1:${port}${path}`, { headers })).json() as Promise<
                Array<{ seq: number; sender: string; url: string }>
            >
    }
}

test("binds to loopback and refuses reads, writes and acknowledgements without the session key", async (t) => {
    const { base, address, post } = await relay(t)
    assert.equal(address, "127.0.0.1")
    await post("requests")
    for (const path of ["/v1/requests?consumer=wallet", "/v1/responses?sender=member-tab"]) {
        for (const method of ["GET", "POST", "DELETE"]) {
            assert.equal((await fetch(`${base}${path}`, { method })).status, 401)
            assert.equal(
                (await fetch(`${base}${path}`, { method, headers: { authorization: "Bearer wrong" } })).status,
                401
            )
        }
    }
    const body = await (await fetch(`${base}/health`)).text()
    assert.equal(body.includes(token), false)
})

test("rejects hostile origins and DNS hosts; allowed preflights permit the authorization header", async (t) => {
    const { base } = await relay(t)
    for (const method of ["GET", "POST", "OPTIONS"]) {
        assert.equal(
            (await fetch(`${base}/v1/requests`, { method, headers: { ...headers, origin: "http://evil.example" } }))
                .status,
            403
        )
    }
    const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(`${base}/health`, { headers: { host: "evil.example" } }, (response) => {
            response.resume()
            resolve(response.statusCode)
        })
        request.on("error", reject)
        request.end()
    })
    assert.equal(status, 421)
    const preflight = await fetch(`${base}/v1/requests`, {
        method: "OPTIONS",
        headers: { origin: "http://localhost:4173" }
    })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://localhost:4173")
    assert.match(preflight.headers.get("access-control-allow-headers")!, /authorization/)
    assert.equal(
        (await fetch(`${base}/v1/requests?consumer=w`, { headers: { origin: "http://localhost:4173" } })).status,
        401
    )
})

test("only one wallet claims a sender, and unfiltered polls cannot bypass the claim", async (t) => {
    const { base, post, get } = await relay(t)
    await post("requests")
    const [a, b] = await Promise.all([get("/v1/requests?consumer=a"), get("/v1/requests?consumer=b")])
    assert.equal(a.length + b.length, 1)
    const winner = a.length ? "a" : "b"
    const loser = winner === "a" ? "b" : "a"
    assert.deepEqual([...a, ...b], [{ seq: 1, sender: "member-tab", url: "userapp://request" }])
    assert.equal((await get(`/v1/requests?consumer=${winner}`)).length, 1)
    assert.equal((await get(`/v1/requests?consumer=${loser}`)).length, 0)
    assert.equal((await fetch(`${base}/v1/requests`, { headers })).status, 400)
    assert.equal((await post("responses", "member-tab", "alpha://response", loser)).status, 403)
    assert.equal((await post("responses", "member-tab", "alpha://response", winner)).status, 200)
})

test("isolates responses by sender and deletes only messages acknowledged by their recipient", async (t) => {
    const { base, post, get } = await relay(t)
    for (const sender of ["a", "b"]) await post("requests", sender)
    await get("/v1/requests?consumer=wallet")
    for (const sender of ["a", "b"]) await post("responses", sender, `${sender}://response`, "wallet")
    assert.deepEqual(
        (await get("/v1/responses?sender=a")).map(({ sender }) => sender),
        ["a"]
    )
    assert.equal((await fetch(`${base}/v1/responses`, { headers })).status, 400)
    await fetch(`${base}/v1/responses?sender=a&after=4`, { method: "DELETE", headers })
    assert.equal((await get("/v1/responses?sender=a")).length, 0)
    assert.equal((await get("/v1/responses?sender=b")).length, 1)
    await fetch(`${base}/v1/requests?consumer=other&after=2`, { method: "DELETE", headers })
    assert.equal((await get("/v1/requests?consumer=wallet")).length, 2)
    await fetch(`${base}/v1/requests?consumer=wallet&after=2`, { method: "DELETE", headers })
    assert.equal((await get("/v1/requests?consumer=wallet")).length, 0)
    // Acknowledging a request keeps its wallet claim until expiry, so the response can still arrive.
    assert.equal((await post("responses", "a", "a://later", "wallet")).status, 200)
})

test("bounds messages and releases expired messages and wallet claims", async (t) => {
    let now = 100
    const { post, get } = await relay(t, { maxMessages: 1, messageTtlMs: 100, now: () => now })
    assert.equal((await post("requests", "a")).status, 200)
    assert.equal((await post("requests", "b")).status, 429)
    assert.equal((await get("/v1/requests?consumer=first")).length, 1)
    assert.equal((await post("responses", "a", "a://response", "first")).status, 200)
    now += 100
    assert.equal((await get("/v1/requests?consumer=first")).length, 0)
    assert.equal((await get("/v1/responses?sender=a")).length, 0)
    assert.equal((await post("requests", "b")).status, 200)
    assert.equal((await get("/v1/requests?consumer=second")).length, 1)
})

test("refuses oversized, malformed and non-JSON messages and invalid cursors", async (t) => {
    const { base, post } = await relay(t, { maxBodyBytes: 256 })
    assert.equal((await post("requests", "member", "x".repeat(300))).status, 413)
    assert.equal(
        (await fetch(`${base}/v1/requests`, { method: "POST", headers: jsonHeaders, body: "null" })).status,
        400
    )
    assert.equal((await fetch(`${base}/v1/requests`, { method: "POST", headers: jsonHeaders, body: "{" })).status, 400)
    assert.equal((await fetch(`${base}/v1/requests`, { method: "POST", headers, body: "{}" })).status, 415)
    for (const after of ["NaN", "-1", "1.1", "9007199254740992"]) {
        assert.equal((await fetch(`${base}/v1/requests?consumer=w&after=${after}`, { headers })).status, 400)
    }
    assert.equal((await post("requests")).status, 200)
})

test("refuses a missing or weak session key before listening", () => {
    assert.throws(() => startLinkRelay(0, [], { token: "" }), /32-byte/)
})

test(
    "the member client completes an authenticated presentation exchange and acknowledges its response",
    { timeout: 5000 },
    async (t) => {
        const { createLinkClient } = await import("../../../packages/user-app-link/src/client")
        const { createRelayWebLinkTransport } = await import("../../../packages/user-app-link/src/web")
        const { decodeRequest, encodeResponse } = await import("../../../packages/user-app-link/src/codec")
        const { presentationCreateParams, presentationCreateResult } =
            await import("../../../packages/user-app-link/tests/fixtures")
        const { base, get, post } = await relay(t)
        const client = createLinkClient({
            caller: { name: "Member", scheme: "memberapp" },
            callback: "memberapp://v1/response",
            timeoutMs: 2000,
            ...createRelayWebLinkTransport({ relayUrl: base, sender: "member-tab", token, pollIntervalMs: 10 })
        })
        const result = client.request("presentation.create", presentationCreateParams)
        let incoming: Awaited<ReturnType<typeof get>> = []
        for (let attempt = 0; incoming.length === 0 && attempt < 100; attempt++) {
            incoming = await get("/v1/requests?consumer=wallet")
            if (incoming.length === 0) await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.equal(incoming.length, 1)
        const request = decodeRequest(incoming[0].url)
        assert.equal(request.op, "presentation.create")
        const response = encodeResponse(request.callback, {
            id: request.id,
            version: "v1",
            ok: true,
            result: presentationCreateResult
        })
        assert.equal((await post("responses", "member-tab", response, "wallet")).status, 200)
        assert.deepEqual(await result, presentationCreateResult)
        for (let attempt = 0; attempt < 100; attempt++) {
            if ((await get("/v1/responses?sender=member-tab")).length === 0) return
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        assert.fail("the delivered response was not acknowledged")
    }
)

test("malformed request targets cannot crash the relay", async (t) => {
    const { base } = await relay(t)
    const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(base, { path: "//[" }, (response) => {
            response.resume()
            resolve(response.statusCode)
        })
        request.on("error", reject)
        request.end()
    })
    assert.equal(status, 400)
    assert.equal((await fetch(`${base}/health`)).status, 200)
})
