import assert from "node:assert/strict"
import { once } from "node:events"
import { mock, test } from "node:test"
import express from "express"
import { rateLimit } from "../src/rate-limit"

async function withApp(
    perMinute: number,
    now: (() => number) | undefined,
    run: (url: string) => Promise<void>
): Promise<void> {
    const app = express()
    const middleware = now === undefined ? rateLimit(perMinute) : rateLimit(perMinute, now)
    app.get("/x", middleware, (_req, res) => res.status(200).json({ ok: true }))
    const server = app.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("server has no TCP address")
    try {
        await run(`http://127.0.0.1:${address.port}`)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

test("the Nth call passes and the N+1th gets 429 with Retry-After", async () => {
    const clock = 0
    await withApp(
        3,
        () => clock,
        async (url) => {
            for (let i = 0; i < 3; i++) {
                assert.equal((await fetch(`${url}/x`)).status, 200)
            }
            const res = await fetch(`${url}/x`)
            assert.equal(res.status, 429)
            assert.deepEqual(await res.json(), { error: "rate limit exceeded", code: "RATE_LIMITED" })
            assert.equal(res.headers.get("retry-after"), "60")
        }
    )
})

test("the window is a half-open [start, start+60s) interval: 59_999ms in still counts, 60_000ms resets", async () => {
    let clock = 0
    await withApp(
        1,
        () => clock,
        async (url) => {
            assert.equal((await fetch(`${url}/x`)).status, 200)

            clock = 59_999
            assert.equal((await fetch(`${url}/x`)).status, 429)

            clock = 60_000
            assert.equal((await fetch(`${url}/x`)).status, 200)
        }
    )
})

test("Retry-After counts down to the window's own end, not always the full 60s", async () => {
    let clock = 0
    await withApp(
        1,
        () => clock,
        async (url) => {
            assert.equal((await fetch(`${url}/x`)).status, 200)
            clock += 41_000
            const res = await fetch(`${url}/x`)
            assert.equal(res.status, 429)
            assert.equal(res.headers.get("retry-after"), "19")
        }
    )
})

test("Retry-After rounds up a sub-second remainder rather than truncating to 0", async () => {
    let clock = 0
    await withApp(
        1,
        () => clock,
        async (url) => {
            assert.equal((await fetch(`${url}/x`)).status, 200)
            clock = 59_999
            const res = await fetch(`${url}/x`)
            assert.equal(res.status, 429)
            assert.equal(res.headers.get("retry-after"), "1")
        }
    )
})

test("without a now argument, the window follows the mocked performance.now, not Date.now", async () => {
    let mockedNow = 0
    const mockedPerformanceNow = mock.method(performance, "now", () => mockedNow)
    try {
        await withApp(1, undefined, async (url) => {
            assert.equal((await fetch(`${url}/x`)).status, 200)
            assert.equal((await fetch(`${url}/x`)).status, 429)

            // Date.now is untouched throughout: if the default fell back to it, this jump
            // wouldn't unlock the window and the next call would still be 429.
            mockedNow += 60_000
            assert.equal((await fetch(`${url}/x`)).status, 200)
        })
    } finally {
        mockedPerformanceNow.mock.restore()
    }
})
