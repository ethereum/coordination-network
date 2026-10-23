import assert from "node:assert/strict"
import { test } from "node:test"
import { Hex32 } from "@coordination-network/credential"
import { InMemoryIssuanceStore } from "../src/stores/issuance-store"
import { IssuanceRecord } from "../src/types"

const SUBJECT = `0x${"11".repeat(32)}` as Hex32

function record(jti: string, exp: number): IssuanceRecord {
    return {
        jti,
        subjectNetworkId: SUBJECT,
        approvalScope: { programme: "demo-programme", country: "ZZZ" },
        nbf: 1,
        exp,
        deviceKeyCommitment: "123",
        revocationCommitment: "456"
    }
}

test("expired issuance records are purged on reads", async () => {
    let now = 100
    const store = new InMemoryIssuanceStore(() => now)
    await store.save(record("expired", 101))
    await store.save(record("live", 102))

    now = 101
    assert.equal(await store.get("expired"), undefined)
    assert.deepEqual(await store.list(), [record("live", 102)])
})

test("issuance records support explicit deletion for erasure", async () => {
    const store = new InMemoryIssuanceStore(() => 100)
    await store.save(record("erase-me", 200))

    assert.equal(await store.delete("erase-me"), true)
    assert.equal(await store.get("erase-me"), undefined)
    assert.equal(await store.delete("erase-me"), false)
})
