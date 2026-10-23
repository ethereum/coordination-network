import assert from "node:assert/strict"
import { test } from "node:test"
import { Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import { ActivityLog } from "../src/activity"
import { buildServer } from "../src/server"
import { InMemoryVerificationStore } from "../src/stores/verification-store"

const ISSUER_ID = `0x${"ee".repeat(32)}` as Hex32

/** No circuit and no chain: closing a request never reaches proof verification. */
function lightweightServer(presentationRequestTtlSeconds?: number) {
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const activityLog = new ActivityLog()
    const verifications = new InMemoryVerificationStore()
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer: new LocalCredentialSigner("issuer-service-close"),
        resolver,
        activityLog,
        verificationStore: verifications,
        presentationRequestTtlSeconds
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    return { base: `http://127.0.0.1:${port}`, activityLog, verifications, close: () => listener.close() }
}

const createRequest = async (base: string): Promise<string> => {
    const res = await fetch(`${base}/v1/presentation-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ programme: "demo-programme", country: "ZZZ" })
    })
    assert.equal(res.status, 201)
    return ((await res.json()) as { requestId: string }).requestId
}

const close = (base: string, requestId: string, code: string) =>
    fetch(`${base}/v1/presentation-requests/${requestId}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code })
    })

test("closing a request stores the wallet's refusal and reports it to the activity log", async () => {
    const server = lightweightServer()
    try {
        const requestId = await createRequest(server.base)

        const res = await close(server.base, requestId, "NO_CREDENTIAL")
        assert.equal(res.status, 200)
        const { verificationId } = (await res.json()) as { verificationId: string }

        const stored = await server.verifications.get(verificationId)
        assert.equal(stored?.ok, false)
        assert.equal(stored?.code, "NO_CREDENTIAL")
        assert.equal(stored?.requestId, requestId)
        assert.deepEqual(
            server.activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
            [{ kind: "verification", message: "verification rejected: NO_CREDENTIAL", outcome: "failed" }]
        )
    } finally {
        server.close()
    }
})

test("closing a request twice reports the second as consumed, like a replayed proof", async () => {
    const server = lightweightServer()
    try {
        const requestId = await createRequest(server.base)
        await close(server.base, requestId, "CREDENTIAL_REVOKED")

        const res = await close(server.base, requestId, "CREDENTIAL_REVOKED")
        assert.equal(res.status, 200)
        const { verificationId } = (await res.json()) as { verificationId: string }
        assert.equal((await server.verifications.get(verificationId))?.code, "CONSUMED_REQUEST")
    } finally {
        server.close()
    }
})

test("closing an expired request reports it expired, the way /v1/verify would", async () => {
    const server = lightweightServer(-10)
    try {
        const requestId = await createRequest(server.base)

        const res = await close(server.base, requestId, "NO_CREDENTIAL")
        assert.equal(res.status, 200)
        const { verificationId } = (await res.json()) as { verificationId: string }
        assert.equal((await server.verifications.get(verificationId))?.code, "EXPIRED_REQUEST")
        assert.deepEqual(
            server.activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
            [{ kind: "verification", message: "verification rejected: EXPIRED_REQUEST", outcome: "failed" }]
        )
    } finally {
        server.close()
    }
})

test("closing an unknown request is a 404, and a code outside the set a 400", async () => {
    const server = lightweightServer()
    try {
        assert.equal(
            (await close(server.base, "urn:uuid:00000000-0000-0000-0000-000000000000", "NO_CREDENTIAL")).status,
            404
        )

        const requestId = await createRequest(server.base)
        assert.equal((await close(server.base, requestId, "PROOF_INVALID")).status, 400)
        assert.deepEqual(server.activityLog.recent(), [])
    } finally {
        server.close()
    }
})
