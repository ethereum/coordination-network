import assert from "node:assert/strict"
import { test } from "node:test"
import { Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import type { IssuerSetBacking } from "../src/issuer-set"
import { buildServer } from "../src/server"

const ISSUER_ID = `0x${"ab".repeat(32)}` as Hex32

async function serve(issuerSet: IssuerSetBacking) {
    const signer = new LocalCredentialSigner("issuer-service-issuers-unit")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver, issuerSet })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    return { base: `http://127.0.0.1:${port}`, close: () => listener.close() }
}

test("GET /v1/issuers reports the set's leaves, root, block number, and contract address as decimal/hex strings", async () => {
    const issuerSet: IssuerSetBacking = {
        address: `0x${"55".repeat(20)}`,
        read: async () => ({ leaves: [1n, 2n], root: 42n, blockNumber: 100n, size: 2 }),
        isValidRoot: async () => true
    }
    const { base, close } = await serve(issuerSet)
    try {
        const res = await fetch(`${base}/v1/issuers`)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), {
            leaves: ["1", "2"],
            root: "42",
            blockNumber: "100",
            approvedIssuerSet: `0x${"55".repeat(20)}`
        })
    } finally {
        close()
    }
})

test("GET /v1/issuers reports approvedIssuerSet as null for an in-memory (chain-free) backing", async () => {
    const issuerSet: IssuerSetBacking = {
        read: async () => ({ leaves: [], root: 0n, blockNumber: 0n, size: 0 }),
        isValidRoot: async () => false
    }
    const { base, close } = await serve(issuerSet)
    try {
        const res = await fetch(`${base}/v1/issuers`)
        assert.equal((await res.json()).approvedIssuerSet, null)
    } finally {
        close()
    }
})

test("GET /v1/issuers 500s when the chain read fails", async () => {
    const issuerSet: IssuerSetBacking = {
        address: `0x${"55".repeat(20)}`,
        read: async () => {
            throw new Error("rpc unavailable")
        },
        isValidRoot: async () => true
    }
    const { base, close } = await serve(issuerSet)
    try {
        const res = await fetch(`${base}/v1/issuers`)
        assert.equal(res.status, 500)
        assert.deepEqual(await res.json(), { error: "internal error" })
    } finally {
        close()
    }
})
