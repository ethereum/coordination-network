import assert from "node:assert/strict"
import { test } from "node:test"
import express from "express"
import { ActivityLog } from "../src/activity"
import { requireMemberServerToken } from "../src/auth"
import { presentationRequestsRouter } from "../src/routes/presentation-requests"
import { recordVerification } from "../src/routes/record-verification"
import { InMemoryPresentationRequestStore } from "../src/stores/presentation-request-store"
import { InMemoryVerificationStore } from "../src/stores/verification-store"

const token = "test-member-server-token"
async function fixture(t: { after: (fn: () => void) => void }) {
    const presentationRequests = new InMemoryPresentationRequestStore()
    const verifications = new InMemoryVerificationStore()
    const activityLog = new ActivityLog()
    const app = express()
    app.use(express.json())
    app.use(
        presentationRequestsRouter({
            presentationRequests,
            verifications,
            activityLog,
            audience: "verifier",
            ttlSeconds: 300,
            requireMemberServerToken: requireMemberServerToken(token)
        })
    )
    const server = app.listen(0, "127.0.0.1")
    await new Promise<void>((resolve) => server.once("listening", resolve))
    t.after(() => server.close())
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const create = (ttlSeconds = 300) =>
        presentationRequests.create({ audience: "verifier", programme: "demo", country: "ZZZ", ttlSeconds })
    const headers = { authorization: `Bearer ${token}` }
    return { base, create, headers, presentationRequests, verifications, activityLog }
}

test("result lookup and cancellation require the member token, including for unknown requests", async (t) => {
    const f = await fixture(t)
    const request = await f.create()
    for (const id of [request.requestId, "unknown"]) {
        for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
            assert.equal((await fetch(`${f.base}/v1/presentation-requests/${id}`, { headers })).status, 401)
            assert.equal(
                (await fetch(`${f.base}/v1/presentation-requests/${id}/cancel`, { method: "POST", headers })).status,
                401
            )
        }
    }
    assert.equal((await fetch(`${f.base}/v1/presentation-requests/unknown`, { headers: f.headers })).status, 404)
})

test("a pending request exposes no challenge or proof and a cancelled request cannot be submitted", async (t) => {
    const f = await fixture(t)
    const request = await f.create()
    const url = `${f.base}/v1/presentation-requests/${request.requestId}`
    const pending = await fetch(url, { headers: f.headers })
    assert.equal(pending.headers.get("cache-control"), "no-store")
    assert.deepEqual(await pending.json(), { status: "pending" })
    assert.equal((await fetch(`${url}/cancel`, { method: "POST", headers: f.headers })).status, 200)
    assert.deepEqual(await (await fetch(url, { headers: f.headers })).json(), { status: "cancelled" })
    assert.equal((await f.presentationRequests.consume(request.requestId))?.alreadyConsumed, true)
})

test("expiry is reported without requiring a proof submission", async (t) => {
    const f = await fixture(t)
    const request = await f.create(-1)
    assert.deepEqual(
        await (await fetch(`${f.base}/v1/presentation-requests/${request.requestId}`, { headers: f.headers })).json(),
        { status: "expired" }
    )
})

test("a lost wallet response is recovered by request ID; replay cannot overwrite the first result", async (t) => {
    const f = await fixture(t)
    const request = await f.create()
    await f.presentationRequests.consume(request.requestId)
    const id = await recordVerification(f, request, Math.floor(Date.now() / 1000), { ok: true })
    await recordVerification(f, request, Math.floor(Date.now() / 1000), { ok: false, code: "CONSUMED_REQUEST" })
    const response = await fetch(`${f.base}/v1/presentation-requests/${request.requestId}`, { headers: f.headers })
    const body = (await response.json()) as {
        status: string
        verification: { verificationId: string; ok: boolean; requestId: string }
    }
    assert.equal(body.status, "completed")
    assert.equal(body.verification.verificationId, id)
    assert.equal(body.verification.ok, true)
    assert.equal(body.verification.requestId, request.requestId)
    assert.equal(
        (
            await fetch(`${f.base}/v1/presentation-requests/${request.requestId}/cancel`, {
                method: "POST",
                headers: f.headers
            })
        ).status,
        409
    )
})

test("proof claiming and cancellation are mutually exclusive under concurrent calls", async (t) => {
    const f = await fixture(t)
    for (const cancelFirst of [true, false]) {
        const request = await f.create()
        const operations = cancelFirst
            ? [f.presentationRequests.cancel(request.requestId), f.presentationRequests.consume(request.requestId)]
            : [f.presentationRequests.consume(request.requestId), f.presentationRequests.cancel(request.requestId)]
        await Promise.all(operations)
        const record = await f.presentationRequests.get(request.requestId)
        assert.equal(record?.consumed, true)
        assert.equal(record?.cancelled === true, cancelFirst)
    }
})
