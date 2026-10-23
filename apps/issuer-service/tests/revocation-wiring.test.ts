import assert from "node:assert/strict"
import { test } from "node:test"
import { Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import { InMemoryIssuanceStore } from "../src/stores/issuance-store"
import { IssuanceRecord } from "../src/types"
import { buildServer } from "../src/server"

const ISSUER_ID = `0x${"77".repeat(32)}` as Hex32

test("default in-memory revocation: revoking through the API updates the snapshot and the backing", async () => {
    const signer = new LocalCredentialSigner("issuer-service-default-revocation-wiring")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)

    const issuanceStore = new InMemoryIssuanceStore()
    const commitment = 123456789n
    const record: IssuanceRecord = {
        jti: "urn:uuid:default-revocation-wiring",
        subjectNetworkId: `0x${"88".repeat(32)}` as Hex32,
        approvalScope: { programme: "demo-programme", country: "ZZZ" },
        nbf: 0,
        exp: Math.floor(Date.now() / 1000) + 60,
        deviceKeyCommitment: "1",
        revocationCommitment: commitment.toString()
    }
    await issuanceStore.save(record)

    // No `revocation` dep: buildServer's default in-memory backing must be the same object the
    // credentials router revokes through, not just the one snapshot/verify read.
    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver, issuanceStore })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`

    try {
        const snapshotBefore = (await (await fetch(`${base}/v1/revocations/snapshot`)).json()) as { root: string }
        assert.equal(snapshotBefore.root, "0")

        const revokeRes = await fetch(`${base}/v1/credentials/${record.jti}/revoke`, { method: "POST" })
        assert.equal(revokeRes.status, 200)

        const snapshotAfter = (await (await fetch(`${base}/v1/revocations/snapshot`)).json()) as { root: string }
        assert.notEqual(snapshotAfter.root, "0")

        const credentialRes = await fetch(`${base}/v1/credentials/${record.jti}`)
        assert.equal(((await credentialRes.json()) as { revoked: boolean }).revoked, true)
    } finally {
        listener.close()
    }
})

test("revoking an already-revoked credential is idempotent", async () => {
    const signer = new LocalCredentialSigner("issuer-service-double-revocation-wiring")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)

    const issuanceStore = new InMemoryIssuanceStore()
    const commitment = 987654321n
    const record: IssuanceRecord = {
        jti: "urn:uuid:double-revocation-wiring",
        subjectNetworkId: `0x${"88".repeat(32)}` as Hex32,
        approvalScope: { programme: "demo-programme", country: "ZZZ" },
        nbf: 0,
        exp: Math.floor(Date.now() / 1000) + 60,
        deviceKeyCommitment: "1",
        revocationCommitment: commitment.toString()
    }
    await issuanceStore.save(record)

    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver, issuanceStore })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`

    try {
        const first = await fetch(`${base}/v1/credentials/${record.jti}/revoke`, { method: "POST" })
        assert.equal(first.status, 200)
        assert.deepEqual(await first.json(), { id: record.jti, revoked: true })

        const rootAfterFirst = ((await (await fetch(`${base}/v1/revocations/snapshot`)).json()) as { root: string })
            .root

        // mirror.revoke throws on a repeat commitment (LeanIMT+'s own "already revoked" guard), so
        // this would 500 without the route checking isRevoked first.
        const second = await fetch(`${base}/v1/credentials/${record.jti}/revoke`, { method: "POST" })
        assert.equal(second.status, 200)
        assert.deepEqual(await second.json(), { id: record.jti, revoked: true })

        const rootAfterSecond = ((await (await fetch(`${base}/v1/revocations/snapshot`)).json()) as { root: string })
            .root
        assert.equal(rootAfterSecond, rootAfterFirst)
    } finally {
        listener.close()
    }
})
