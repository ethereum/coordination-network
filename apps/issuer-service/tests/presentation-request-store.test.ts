import assert from "node:assert/strict"
import { test } from "node:test"
import { InMemoryPresentationRequestStore } from "../src/stores/presentation-request-store"

test("create issues a fresh, unconsumed request with a 31-byte challenge and the given TTL", async () => {
    const store = new InMemoryPresentationRequestStore()

    const before = Math.floor(Date.now() / 1000)
    const record = await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })
    const after = Math.floor(Date.now() / 1000)

    assert.match(record.requestId, /^urn:uuid:[0-9a-f-]{36}$/)
    assert.equal(record.challenge.length, 31)
    assert.equal(record.audience, "aud")
    assert.equal(record.programme, "demo-programme")
    assert.equal(record.country, "ZZZ")
    assert.equal(record.consumed, false)
    assert.ok(record.currentTime >= before && record.currentTime <= after)
    assert.equal(record.expiresAt, record.currentTime + 60)
})

test("get returns the created record, and undefined for an unknown id", async () => {
    const store = new InMemoryPresentationRequestStore()
    const created = await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })

    assert.deepEqual(await store.get(created.requestId), created)
    assert.equal(await store.get("urn:uuid:00000000-0000-0000-0000-000000000000"), undefined)
})

test("consume atomically claims a request: only the first call reports alreadyConsumed false", async () => {
    const store = new InMemoryPresentationRequestStore()
    const created = await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })

    const first = await store.consume(created.requestId)
    assert.equal(first?.alreadyConsumed, false)
    assert.equal(first?.record.requestId, created.requestId)
    assert.equal(first?.record.consumed, true)

    // A second consume of the same request reports it was already claimed, and does not
    // otherwise disturb the record.
    const second = await store.consume(created.requestId)
    assert.equal(second?.alreadyConsumed, true)
    assert.equal(second?.record.requestId, created.requestId)
    assert.equal(second?.record.consumed, true)
})

test("two concurrent consume calls for the same request agree on exactly one non-alreadyConsumed result", async () => {
    const store = new InMemoryPresentationRequestStore()
    const created = await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })

    const [first, second] = await Promise.all([store.consume(created.requestId), store.consume(created.requestId)])

    const claims = [first?.alreadyConsumed, second?.alreadyConsumed]
    assert.deepEqual(claims.sort(), [false, true])
})

test("consuming an unknown id returns undefined", async () => {
    const store = new InMemoryPresentationRequestStore()

    assert.equal(await store.consume("urn:uuid:00000000-0000-0000-0000-000000000000"), undefined)
})

test("two requests from the same store get distinct requestIds and challenges", async () => {
    const store = new InMemoryPresentationRequestStore()

    const a = await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })
    const b = await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })

    assert.notEqual(a.requestId, b.requestId)
    assert.notDeepEqual(a.challenge, b.challenge)
})

test("create prunes an entry once its own TTL has passed, consumed or not", async () => {
    const store = new InMemoryPresentationRequestStore()
    const expiredUnconsumed = await store.create({
        audience: "aud",
        programme: "demo-programme",
        country: "ZZZ",
        ttlSeconds: -1
    })
    // Pruning happens on create(), not on every read, and not on this record's own creation.
    assert.ok(await store.get(expiredUnconsumed.requestId))

    // This create() call's own pruning step already sees expiredUnconsumed as past its TTL (both
    // were created with the same already-expired ttlSeconds, so by now it definitely is), and
    // removes it as a side effect — checked below, not here, since that removal is exactly what
    // this test is about.
    const expiredConsumed = await store.create({
        audience: "aud",
        programme: "demo-programme",
        country: "ZZZ",
        ttlSeconds: -1
    })
    await store.consume(expiredConsumed.requestId)

    const fresh = await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })

    assert.equal(await store.get(expiredUnconsumed.requestId), undefined)
    assert.equal(await store.get(expiredConsumed.requestId), undefined)
    assert.ok(await store.get(fresh.requestId))
})

test("create does not prune an entry that is merely consumed but still within its TTL", async () => {
    const store = new InMemoryPresentationRequestStore()
    const created = await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })
    await store.consume(created.requestId)

    await store.create({ audience: "aud", programme: "demo-programme", country: "ZZZ", ttlSeconds: 60 })

    assert.equal((await store.get(created.requestId))?.consumed, true)
})

test("completed results remain recoverable after challenge expiry but are eventually pruned", async () => {
    let now = 100
    const store = new InMemoryPresentationRequestStore(60, () => now)
    const record = await store.create({ audience: "aud", programme: "demo", country: "ZZZ", ttlSeconds: 1 })
    await store.consume(record.requestId)
    now = 102
    await store.create({ audience: "aud", programme: "demo", country: "ZZZ", ttlSeconds: 300 })
    assert.equal(await store.get(record.requestId), undefined)
    // The in-flight proof was claimed before expiry, and verification just finished.
    await store.complete(record, "original-result")
    await store.complete(record, "later-result")
    now = 120
    await store.create({ audience: "aud", programme: "demo", country: "ZZZ", ttlSeconds: 300 })
    assert.equal((await store.get(record.requestId))?.verificationId, "original-result")
    now = 163
    await store.create({ audience: "aud", programme: "demo", country: "ZZZ", ttlSeconds: 300 })
    assert.equal(await store.get(record.requestId), undefined)
})
