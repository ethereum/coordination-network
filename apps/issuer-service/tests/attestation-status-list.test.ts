import assert from "node:assert/strict"
import { test, type TestContext } from "node:test"
import { createStatusListCache, parseStatusList, type StatusListCacheOptions } from "../src/attestation/status-list"

const STATUS_URL = "https://status.example/attestation/status"
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const LIST = {
    entries: {
        "2c8cdddfd5e03bfc": { status: "REVOKED", reason: "KEY_COMPROMISE" },
        "00c8966fcb2fbe32": { status: "SUSPENDED", reason: "SOFTWARE_FLAW", expires: "2030-01-01" },
        "6681152659205225093": { status: "REVOKED", reason: "KEY_COMPROMISE", comment: "anything" }
    }
}

test("parses every listed serial, REVOKED or SUSPENDED, without leading zeros", () => {
    assert.deepEqual(
        parseStatusList(LIST),
        new Set(["2c8cdddfd5e03bfc", "c8966fcb2fbe32", "6681152659205225093", "5cb838f1fe157a85"])
    )
})

test("reads an all-digit serial as both hex and decimal, and one with a-f as hex only", () => {
    const entries = { "0012": { status: "REVOKED" }, "00c8": { status: "REVOKED" } }
    assert.deepEqual(parseStatusList({ entries }), new Set(["12", "c", "c8"]))
})

for (const [name, body] of [
    ["an empty list", { entries: {} }],
    ["no entries", {}],
    ["a non-hex serial", { entries: { "xyz-1": { status: "REVOKED" } } }],
    ["an empty serial", { entries: { "": { status: "REVOKED" } } }],
    ["an entry without a status", { entries: { abc: { reason: "KEY_COMPROMISE" } } }],
    ["a non-object entry", { entries: { abc: "REVOKED" } }],
    ["an array", []]
] as const) {
    test(`refuses ${name}`, () => {
        assert.throws(() => parseStatusList(body))
    })
}

interface FakeServer {
    fetch: NonNullable<StatusListCacheOptions["fetch"]>
    calls: () => number
    respond: (next: () => Response | Promise<Response>) => void
}

function fakeServer(first: () => Response | Promise<Response>): FakeServer {
    let calls = 0
    let respond = first
    return {
        fetch: async () => {
            calls += 1
            return respond()
        },
        calls: () => calls,
        respond: (next) => {
            respond = next
        }
    }
}

const ok = (maxAge?: number, body: unknown = LIST) =>
    new Response(JSON.stringify(body), {
        headers: maxAge === undefined ? {} : { "cache-control": `public, max-age=${maxAge}` }
    })

const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve))
}

function cache(fetch: FakeServer["fetch"], options: Partial<StatusListCacheOptions> = {}) {
    let now = 1_000_000
    const list = createStatusListCache({ fetch, url: STATUS_URL, now: () => now, log: () => {}, ...options })
    return {
        list,
        advance: (ms: number) => {
            now += ms
        }
    }
}

test("is unavailable until the first fetch lands, then serves the list", async () => {
    const server = fakeServer(() => ok(86400))
    const { list } = cache(server.fetch)
    assert.deepEqual(list.snapshot(), { unavailable: "never-fetched" })
    assert.equal(await list.start(), true)
    const snapshot = list.snapshot()
    assert.ok(!("unavailable" in snapshot))
    assert.equal(snapshot.serials.has("c8966fcb2fbe32"), true)
    list.stop()
})

test("goes stale once the last good copy is older than the limit", async () => {
    const server = fakeServer(() => ok(86400))
    const { list, advance } = cache(server.fetch, { maxStaleMs: 72 * HOUR })
    await list.start()
    advance(72 * HOUR)
    assert.ok(!("unavailable" in list.snapshot()))
    advance(1)
    assert.deepEqual(list.snapshot(), { unavailable: "stale" })
    list.stop()
})

for (const [name, response] of [
    ["an HTTP error", () => new Response("nope", { status: 503 })],
    ["a malformed body", () => new Response("{not json")],
    ["an empty list", () => ok(60, { entries: {} })],
    ["a body over the size cap", () => ok(60, { entries: { abc: { status: "REVOKED", pad: "x".repeat(4096) } } })],
    [
        "a declared length over the size cap",
        () => new Response(JSON.stringify(LIST), { headers: { "content-length": "999999" } })
    ],
    [
        "a network failure",
        () => {
            throw new TypeError("fetch failed")
        }
    ]
] as const) {
    test(`a first fetch failing on ${name} leaves the list never-fetched`, async () => {
        const logged: string[] = []
        const { list } = cache(fakeServer(response).fetch, { maxBytes: 1024, log: (message) => logged.push(message) })
        assert.equal(await list.start(), false)
        assert.deepEqual(list.snapshot(), { unavailable: "never-fetched" })
        assert.equal(logged.length, 1)
        list.stop()
    })
}

test("gives up on a fetch that outlasts the timeout", async () => {
    const hanging: FakeServer["fetch"] = (_url, init) =>
        new Promise((_resolve, reject) => {
            // Stands in for the open socket a real request holds; Node 22 unrefs the abort timer.
            const socket = setTimeout(() => {}, 60_000)
            init?.signal?.addEventListener("abort", () => {
                clearTimeout(socket)
                reject(init.signal?.reason)
            })
        })
    const { list } = cache(hanging, { timeoutMs: 20 })
    assert.equal(await list.start(), false)
    list.stop()
})

function useFakeTimers(t: TestContext) {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    return async (ms: number) => {
        t.mock.timers.tick(ms)
        await settle()
    }
}

test("refreshes at the response's max-age, clamped to 15 minutes and 24 hours", async (t) => {
    const tick = useFakeTimers(t)
    for (const [maxAge, expectedMs] of [
        [3600, HOUR],
        [60, 15 * MINUTE],
        [7 * 86400, 24 * HOUR],
        [undefined, 15 * MINUTE]
    ] as const) {
        const server = fakeServer(() => ok(maxAge))
        const { list } = cache(server.fetch)
        await list.start()
        await tick(expectedMs - 1)
        assert.equal(server.calls(), 1, `max-age ${maxAge}`)
        await tick(1)
        assert.equal(server.calls(), 2, `max-age ${maxAge}`)
        list.stop()
    }
})

test("backs off from 1 to 30 minutes on failure and keeps the last good copy", async (t) => {
    const tick = useFakeTimers(t)
    const server = fakeServer(() => ok(900))
    const { list } = cache(server.fetch)
    await list.start()
    server.respond(() => new Response("down", { status: 500 }))

    await tick(15 * MINUTE)
    assert.equal(server.calls(), 2)
    const kept = list.snapshot()
    assert.ok(!("unavailable" in kept) && kept.serials.has("2c8cdddfd5e03bfc"))

    for (const backoffMinutes of [1, 2, 4, 8, 16, 30, 30]) {
        const before = server.calls()
        await tick(backoffMinutes * MINUTE - 1)
        assert.equal(server.calls(), before, `before ${backoffMinutes} min`)
        await tick(1)
        assert.equal(server.calls(), before + 1, `at ${backoffMinutes} min`)
    }

    server.respond(() => ok(3600, { entries: { abcdef: { status: "REVOKED" } } }))
    await tick(30 * MINUTE)
    const refreshed = list.snapshot()
    assert.ok(!("unavailable" in refreshed))
    assert.deepEqual(refreshed.serials, new Set(["abcdef"]))
    await tick(HOUR - 1)
    const calls = server.calls()
    await tick(1)
    assert.equal(server.calls(), calls + 1)
    list.stop()
})

test("refreshes within half the staleness limit, so a list that keeps loading never goes stale", async (t) => {
    const tick = useFakeTimers(t)
    const server = fakeServer(() => ok(86400))
    const { list, advance } = cache(server.fetch, { maxStaleMs: HOUR })
    const pass = async (ms: number) => {
        advance(ms)
        await tick(ms)
    }
    await list.start()
    await pass(30 * MINUTE - 1)
    assert.equal(server.calls(), 1)
    await pass(1)
    assert.equal(server.calls(), 2)
    for (let minute = 0; minute < 24 * 60; minute++) {
        await pass(MINUTE)
        assert.ok(!("unavailable" in list.snapshot()), `minute ${minute}`)
    }
    list.stop()
})

test("keeps the refresh floor and the failure backoff within half the staleness limit", async (t) => {
    const tick = useFakeTimers(t)
    const server = fakeServer(() => ok(60))
    const { list } = cache(server.fetch, { maxStaleMs: 10 * MINUTE })
    await list.start()
    await tick(5 * MINUTE)
    assert.equal(server.calls(), 2)

    server.respond(() => new Response("down", { status: 500 }))
    await tick(5 * MINUTE)
    for (const backoffMinutes of [1, 2, 4, 5, 5]) {
        const before = server.calls()
        await tick(backoffMinutes * MINUTE - 1)
        assert.equal(server.calls(), before, `before ${backoffMinutes} min`)
        await tick(1)
        assert.equal(server.calls(), before + 1, `at ${backoffMinutes} min`)
    }
    list.stop()
})

test("a failed first fetch retries after a minute", async (t) => {
    const tick = useFakeTimers(t)
    const server = fakeServer(() => new Response("down", { status: 500 }))
    const { list } = cache(server.fetch)
    assert.equal(await list.start(), false)
    server.respond(() => ok(86400))
    await tick(MINUTE)
    assert.equal(server.calls(), 2)
    assert.ok(!("unavailable" in list.snapshot()))
    list.stop()
})

test("stop cancels the next refresh", async (t) => {
    const tick = useFakeTimers(t)
    const server = fakeServer(() => ok(900))
    const { list } = cache(server.fetch)
    await list.start()
    list.stop()
    await tick(24 * HOUR)
    assert.equal(server.calls(), 1)
})

// No stop(): an unref'd refresh timer must not keep this test file's process alive.
test("the refresh timer does not hold the process open", async () => {
    const { list } = cache(fakeServer(() => ok(86400)).fetch)
    assert.equal(await list.start(), true)
})
