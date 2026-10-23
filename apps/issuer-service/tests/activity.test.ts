import assert from "node:assert/strict"
import { test } from "node:test"
import { ActivityLog, excerpt } from "../src/activity"

test("recent() returns newest first", () => {
    const log = new ActivityLog()
    log.append("credential", "first")
    log.append("credential", "second")
    log.append("revocation", "third")

    assert.deepEqual(
        log.recent().map((entry) => entry.message),
        ["third", "second", "first"]
    )
})

test("recent(limit) caps how many entries come back, still newest first", () => {
    const log = new ActivityLog()
    log.append("credential", "first")
    log.append("credential", "second")
    log.append("revocation", "third")

    assert.deepEqual(
        log.recent(2).map((entry) => entry.message),
        ["third", "second"]
    )
})

test("append carries refs through to recent()", () => {
    const log = new ActivityLog()
    log.append("governance", "admitted a member", { networkId: "0xabc" })

    assert.deepEqual(log.recent()[0].refs, { networkId: "0xabc" })
})

test("append carries outcome through to recent()", () => {
    const log = new ActivityLog()
    log.append("registration", "registered a network id", undefined, "ok")
    log.append("registration", "registration failed: REGISTRY_UNAVAILABLE", undefined, "failed")
    log.append("registration", "found an existing registration")

    assert.deepEqual(
        log.recent().map((entry) => entry.outcome),
        [undefined, "failed", "ok"]
    )
})

test("excerpt() keeps at, kind and message but drops refs and outcome", () => {
    const entry = {
        at: 1700000000000,
        kind: "registration" as const,
        message: "registered a network id",
        refs: { networkId: "0xabc" },
        outcome: "ok" as const
    }

    assert.deepEqual(excerpt(entry), {
        at: 1700000000000,
        kind: "registration",
        message: "registered a network id"
    })
})

test("the ring caps at 200 entries, dropping the oldest first", () => {
    const log = new ActivityLog()
    for (let i = 0; i < 250; i += 1) {
        log.append("verification", `entry-${i}`)
    }

    const entries = log.recent(250)
    assert.equal(entries.length, 200)
    // Newest first: entry-249 is the most recent, entry-50 is the oldest still kept.
    assert.equal(entries[0].message, "entry-249")
    assert.equal(entries[entries.length - 1].message, "entry-50")
})
