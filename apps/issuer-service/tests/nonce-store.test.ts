import assert from "node:assert/strict"
import { test } from "node:test"
import type { Hex32 } from "@coordination-network/credential"
import { InMemoryNonceStore } from "../src/stores/nonce-store"

const SUBJECT = `0x${"11".repeat(32)}` as Hex32

test("issuing a second challenge does not overwrite the first", async () => {
    const store = new InMemoryNonceStore()
    const first = await store.issue(SUBJECT)
    const second = await store.issue(SUBJECT)

    assert.notEqual(first.challengeId, second.challengeId)
    assert.deepEqual(await store.get(first.challengeId, SUBJECT), first.nonce)
    assert.deepEqual(await store.get(second.challengeId, SUBJECT), second.nonce)
})

test("a challenge is bound to both its opaque id and subject", async () => {
    const store = new InMemoryNonceStore()
    const challenge = await store.issue(SUBJECT)
    const other = `0x${"22".repeat(32)}` as Hex32

    assert.equal(await store.get(challenge.challengeId, other), null)
    assert.equal(await store.get("123e4567-e89b-42d3-a456-426614174000", SUBJECT), null)
    assert.deepEqual(await store.get(challenge.challengeId, SUBJECT), challenge.nonce)
})

test("only one concurrent request can consume a challenge", async () => {
    const store = new InMemoryNonceStore()
    const challenge = await store.issue(SUBJECT)
    const results = await Promise.all([
        store.consume(challenge.challengeId, SUBJECT),
        store.consume(challenge.challengeId, SUBJECT)
    ])

    assert.deepEqual(results.sort(), [false, true])
    assert.equal(await store.get(challenge.challengeId, SUBJECT), null)
})
