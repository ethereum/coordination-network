import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import express, { NextFunction, Request, Response } from "express"
import { ActivityLog } from "../src/activity"
import { IssuerSetBacking } from "../src/issuer-set"
import { RevocationBacking } from "../src/revocation"
import { verifyRouter, VerifyRouterDeps } from "../src/routes/verify"
import { InMemoryPresentationRequestStore } from "../src/stores/presentation-request-store"
import { InMemoryVerificationStore } from "../src/stores/verification-store"

// A minimal ABI that fails `assertZkCredentialCircuitAbi` (it names one public parameter, not the
// circuit's real five) but still parses as JSON, so the failure surfaces from proof-system
// construction rather than from readFileSync/JSON.parse.
const circuitWithBadParam = (paramName: string) =>
    JSON.stringify({ abi: { parameters: [{ name: paramName, visibility: "public" }] } })

function buildTestApp(deps: VerifyRouterDeps) {
    const app = express()
    app.use(express.json())
    app.use(verifyRouter(deps))
    // verifyRouter only calls next(error) on failure; it does no formatting of its own, so this
    // stands in for whatever error middleware a real deployment mounts.
    app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) {
            next(err)
            return
        }
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) })
    })
    return app
}

test("a rejected proof-system creation does not poison the cache: the next request retries against the current file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "issuer-service-verify-cache-"))
    const circuitPath = join(dir, "credential.json")
    writeFileSync(circuitPath, circuitWithBadParam("first_bad_param"))

    const presentationRequests = new InMemoryPresentationRequestStore()
    const app = buildTestApp({
        issuerSet: {
            isValidRoot: async () => {
                throw new Error("issuerSet.isValidRoot should not be reached: proof-system creation fails first")
            }
        } as unknown as IssuerSetBacking,
        revocation: {
            isValidRoot: async () => {
                throw new Error("revocation.isValidRoot should not be reached: proof-system creation fails first")
            }
        } as unknown as RevocationBacking,
        verifications: new InMemoryVerificationStore(),
        presentationRequests,
        credentialCircuitPath: circuitPath,
        verifyMaxSkewSeconds: 300,
        activityLog: new ActivityLog()
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`

    const verify = async (requestId: string) => {
        const res = await fetch(`${base}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId, proof: "0x00", publicInputs: [] })
        })
        return (await res.json()) as { error: string }
    }

    try {
        const requestA = await presentationRequests.create({
            audience: "aud",
            programme: "demo-programme",
            country: "ZZZ",
            ttlSeconds: 300
        })
        const first = await verify(requestA.requestId)
        assert.match(first.error, /first_bad_param/)

        // Rewrite the same path with a different invalid ABI. Under the bug, getProofSystem()
        // never re-reads it: the first rejected promise is cached forever, so a second request
        // would replay the same "first_bad_param" failure instead of seeing this file.
        writeFileSync(circuitPath, circuitWithBadParam("second_bad_param"))
        const requestB = await presentationRequests.create({
            audience: "aud",
            programme: "demo-programme",
            country: "ZZZ",
            ttlSeconds: 300
        })
        const second = await verify(requestB.requestId)
        assert.match(second.error, /second_bad_param/)
        assert.notEqual(second.error, first.error)
    } finally {
        listener.close()
        rmSync(dir, { recursive: true, force: true })
    }
})

/** These four cases all return before `getProofSystem()` is ever called, so a circuit path that
 *  is never read is fine here. */
function lightweightApp(activityLog: ActivityLog, deps: Partial<VerifyRouterDeps> = {}) {
    return buildTestApp({
        issuerSet: {
            isValidRoot: async () => {
                throw new Error("issuerSet.isValidRoot should not be reached: this case returns before it")
            }
        } as unknown as IssuerSetBacking,
        revocation: {
            isValidRoot: async () => {
                throw new Error("revocation.isValidRoot should not be reached: this case returns before it")
            }
        } as unknown as RevocationBacking,
        verifications: new InMemoryVerificationStore(),
        presentationRequests: new InMemoryPresentationRequestStore(),
        credentialCircuitPath: "/should-not-be-read.json",
        verifyMaxSkewSeconds: 300,
        activityLog,
        ...deps
    })
}

test("an unknown requestId does not append anything to the activity log", async () => {
    const activityLog = new ActivityLog()
    const app = lightweightApp(activityLog)
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }

    try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                requestId: "urn:uuid:00000000-0000-0000-0000-000000000000",
                proof: "0x00",
                publicInputs: []
            })
        })
        assert.deepEqual(await res.json(), { ok: false, code: "UNKNOWN_REQUEST" })
        assert.deepEqual(activityLog.recent(), [])
    } finally {
        listener.close()
    }
})

test("replaying an already-consumed request tags the activity log with a failed outcome naming the code", async () => {
    const activityLog = new ActivityLog()
    const presentationRequests = new InMemoryPresentationRequestStore()
    const app = lightweightApp(activityLog, { presentationRequests })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }

    try {
        const request = await presentationRequests.create({
            audience: "aud",
            programme: "demo-programme",
            country: "ZZZ",
            ttlSeconds: 300
        })
        await presentationRequests.consume(request.requestId)

        const res = await fetch(`http://127.0.0.1:${port}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: request.requestId, proof: "0x00", publicInputs: [] })
        })
        const body = (await res.json()) as { ok: boolean; code?: string }
        assert.equal(body.ok, false)
        assert.equal(body.code, "CONSUMED_REQUEST")
        assert.deepEqual(
            activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
            [{ kind: "verification", message: "verification rejected: CONSUMED_REQUEST", outcome: "failed" }]
        )
    } finally {
        listener.close()
    }
})

test("an expired request tags the activity log with a failed outcome naming the code", async () => {
    const activityLog = new ActivityLog()
    const presentationRequests = new InMemoryPresentationRequestStore()
    const app = lightweightApp(activityLog, { presentationRequests })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }

    try {
        const request = await presentationRequests.create({
            audience: "aud",
            programme: "demo-programme",
            country: "ZZZ",
            ttlSeconds: -10
        })

        const res = await fetch(`http://127.0.0.1:${port}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: request.requestId, proof: "0x00", publicInputs: [] })
        })
        const body = (await res.json()) as { ok: boolean; code?: string }
        assert.equal(body.ok, false)
        assert.equal(body.code, "EXPIRED_REQUEST")
        assert.deepEqual(
            activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
            [{ kind: "verification", message: "verification rejected: EXPIRED_REQUEST", outcome: "failed" }]
        )
    } finally {
        listener.close()
    }
})

test("a request whose current time has drifted past the skew budget tags the activity log with a failed outcome", async () => {
    const activityLog = new ActivityLog()
    const presentationRequests = new InMemoryPresentationRequestStore()
    const app = lightweightApp(activityLog, { presentationRequests, verifyMaxSkewSeconds: 5 })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }

    try {
        const request = await presentationRequests.create({
            audience: "aud",
            programme: "demo-programme",
            country: "ZZZ",
            ttlSeconds: 300
        })
        // The store returns the live record, not a copy, so mutating it here pushes currentTime
        // outside the 5-second skew budget without touching expiresAt.
        const record = await presentationRequests.get(request.requestId)
        assert.ok(record)
        record.currentTime -= 1000

        const res = await fetch(`http://127.0.0.1:${port}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: request.requestId, proof: "0x00", publicInputs: [] })
        })
        const body = (await res.json()) as { ok: boolean; code?: string }
        assert.equal(body.ok, false)
        assert.equal(body.code, "STALE_CURRENT_TIME")
        assert.deepEqual(
            activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
            [{ kind: "verification", message: "verification rejected: STALE_CURRENT_TIME", outcome: "failed" }]
        )
    } finally {
        listener.close()
    }
})
