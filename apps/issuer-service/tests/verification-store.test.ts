import assert from "node:assert/strict"
import { test } from "node:test"
import { InMemoryVerificationStore, VerificationRecord } from "../src/stores/verification-store"

function record(verificationId: string, verifiedAt: number): VerificationRecord {
    return {
        verificationId,
        requestId: "request",
        ok: true,
        audience: "audience",
        currentTime: verifiedAt,
        challenge: "0x01",
        programme: "demo-programme",
        country: "ZZZ",
        verifiedAt
    }
}

test("verification records are purged when their retention period ends", async () => {
    let now = 100
    const store = new InMemoryVerificationStore(10, () => now)
    await store.save(record("expired", 90))
    await store.save(record("live", 91))

    assert.equal(await store.get("expired"), undefined)
    assert.deepEqual(await store.get("live"), record("live", 91))

    now = 101
    assert.equal(await store.get("live"), undefined)
})

test("verification records support explicit deletion for erasure", async () => {
    const store = new InMemoryVerificationStore(10, () => 100)
    await store.save(record("erase-me", 100))

    assert.equal(await store.delete("erase-me"), true)
    assert.equal(await store.get("erase-me"), undefined)
    assert.equal(await store.delete("erase-me"), false)
})
