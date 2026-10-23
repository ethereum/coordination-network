import assert from "node:assert/strict"
import { test } from "node:test"
import { toFunctionSelector } from "viem"
import { buildChainRevocation, createInMemoryRevocation } from "../src/revocation"

const REGISTRY_ADDRESS = `0x${"cc".repeat(20)}` as `0x${string}`
const SERVICE_ADDRESS = `0x${"dd".repeat(20)}` as `0x${string}`
const SEMAPHORE_ADDRESS = `0x${"ee".repeat(20)}` as `0x${string}`
const REGISTRY_ID = 5n
const MEMBER_IDENTITY_SECRET = new Uint8Array(32).fill(0x22)
const MEMBER_PRIVATE_KEY = `0x${"11".repeat(32)}` as `0x${string}`

const revocationConfig = {
    address: REGISTRY_ADDRESS,
    memberIdentitySecret: MEMBER_IDENTITY_SECRET,
    memberPrivateKey: MEMBER_PRIVATE_KEY,
    memberGroupFromBlock: 0
}

const fakeBase = {
    isApprovedNetworkMember: async () => true,
    getCredentialPublicKey: async () => null,
    isRevoked: async () => false,
    revoke: async () => {}
}

// buildChainRevocation reads the revocation service, registry id and Semaphore group off the
// registry contract, then rebuilds its mirror from the service's own leaves
// (getRevocationTreeLeafCount, then getLeaf per index), checking the result against
// getRevocationRoot — all before any of a test's own chain interaction. A leaf count of 0 (no
// history) always answers with an empty, matching mirror, so these selectors are fixed regardless
// of what a given test's `onCall` fixture returns for its later, test-specific reads.
const REVOCATION_SELECTOR = toFunctionSelector("function REVOCATION() view returns (address)")
const REGISTRY_ID_SELECTOR = toFunctionSelector("function REGISTRY_ID() view returns (uint256)")
const SEMAPHORE_SELECTOR = toFunctionSelector("function SEMAPHORE() view returns (address)")
const NETWORK_MEMBER_GROUP_ID_SELECTOR = toFunctionSelector("function NETWORK_MEMBER_GROUP_ID() view returns (uint256)")
const GET_REVOCATION_TREE_LEAF_COUNT_SELECTOR = toFunctionSelector(
    "function getRevocationTreeLeafCount(uint256 registryId) view returns (uint256)"
)
const GET_REVOCATION_ROOT_SELECTOR = toFunctionSelector(
    "function getRevocationRoot(uint256 registryId) view returns (uint256)"
)
const IS_VALID_ROOT_SELECTOR = toFunctionSelector("function isValidRoot(uint256 revocationRoot) view returns (bool)")

interface Call {
    to: `0x${string}`
    data: `0x${string}`
}

/**
 * Stands in for anvil: answers the fixed sequence of JSON-RPC calls `buildChainRevocation`'s
 * clients make (chain id, the registry's own getters, the mirror rebuild's leaf count and root
 * check), with `eth_call`s other than those routed to `onCall` so each test controls what a
 * contract read returns. viem's `http` transport posts one JSON-RPC request per `fetch` call here
 * (no batching by default), so a single-request-per-call responder is enough.
 */
function mockRpc(onCall: (call: Call) => `0x${string}`): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }
        let result: unknown
        switch (body.method) {
            case "eth_chainId":
                result = "0x7a69"
                break
            case "eth_call": {
                const [call] = body.params as [Call]
                if (call.data.startsWith(REVOCATION_SELECTOR)) {
                    result = addressResult(SERVICE_ADDRESS)
                } else if (call.data.startsWith(REGISTRY_ID_SELECTOR)) {
                    result = uintResult(REGISTRY_ID)
                } else if (call.data.startsWith(SEMAPHORE_SELECTOR)) {
                    result = addressResult(SEMAPHORE_ADDRESS)
                } else if (call.data.startsWith(NETWORK_MEMBER_GROUP_ID_SELECTOR)) {
                    result = uintResult(3n)
                } else if (call.data.startsWith(GET_REVOCATION_TREE_LEAF_COUNT_SELECTOR)) {
                    result = uintResult(0n)
                } else if (call.data.startsWith(GET_REVOCATION_ROOT_SELECTOR)) {
                    result = uintResult(0n)
                } else {
                    result = onCall(call)
                }
                break
            }
            default:
                result = "0x0"
        }
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
            status: 200,
            headers: { "content-type": "application/json" }
        })
    }) as typeof fetch
    return () => {
        globalThis.fetch = original
    }
}

const boolResult = (value: boolean): `0x${string}` => `0x${"0".repeat(63)}${value ? "1" : "0"}`
const uintResult = (value: bigint): `0x${string}` => `0x${value.toString(16).padStart(64, "0")}`
const addressResult = (address: `0x${string}`): `0x${string}` => `0x${address.slice(2).padStart(64, "0")}`

test("the revocation service and registry id come from the registry contract, not the config", async () => {
    const restore = mockRpc(() => boolResult(false))
    try {
        const revocation = await buildChainRevocation(revocationConfig, "http://fake-rpc.test", fakeBase)

        // Published by the snapshot as the pair that reads the tree directly, so it has to name the
        // service holding it, not the registry that gates writes on it.
        assert.equal(revocation.registryAddress?.toLowerCase(), SERVICE_ADDRESS)
        assert.equal(revocation.registryId, REGISTRY_ID)
    } finally {
        restore()
    }
})

test("isRevoked delegates to the chain read, not the local mirror", async () => {
    const restore = mockRpc(() => boolResult(true))
    try {
        const revocation = await buildChainRevocation(revocationConfig, "http://fake-rpc.test", fakeBase)

        assert.equal(await revocation.isRevoked(123n), true)
        // The local mirror never saw this commitment: a value of true can only have come from the
        // chain read, not from `mirror.isRevoked` being consulted instead.
        assert.equal(revocation.mirror.isRevoked(123n), false)
    } finally {
        restore()
    }
})

test("isRevokedLocally answers from the mirror, making none of the chain reads isRevoked does", async () => {
    const restore = mockRpc(() => boolResult(true))
    try {
        const revocation = await buildChainRevocation(revocationConfig, "http://fake-rpc.test", fakeBase)

        // The chain says revoked and the freshly rebuilt mirror has never seen this commitment, so
        // only a mirror read can answer false here.
        assert.equal(await revocation.isRevoked(123n), true)
        assert.equal(revocation.isRevokedLocally(123n), false)
    } finally {
        restore()
    }
})

test("isValidRoot asks the registry for the root alone, naming no tree", async () => {
    const asked: { to: `0x${string}`; args: string }[] = []
    const restore = mockRpc((call) => {
        if (!call.data.startsWith(IS_VALID_ROOT_SELECTOR)) return boolResult(false)
        asked.push({ to: call.to, args: call.data.slice(10) })
        return boolResult(true)
    })
    try {
        const revocation = await buildChainRevocation(revocationConfig, "http://fake-rpc.test", fakeBase)

        assert.equal(await revocation.isValidRoot(99n), true)
        // One word of calldata, the root: a registry id would make it two, and which tree a
        // verifier asks about is what would name the issuer.
        assert.deepEqual(asked, [{ to: REGISTRY_ADDRESS, args: 99n.toString(16).padStart(64, "0") }])
    } finally {
        restore()
    }
})

test("createInMemoryRevocation: with no chain there is neither a registry address nor an id", () => {
    const revocation = createInMemoryRevocation(fakeBase)

    assert.equal(revocation.registryAddress, null)
    assert.equal(revocation.registryId, null)
})

test("createInMemoryRevocation: isValidRoot only accepts the mirror's own current root", async () => {
    const revocation = createInMemoryRevocation(fakeBase)

    assert.equal(await revocation.isValidRoot(0n), true)
    await revocation.revoke(456n)
    assert.equal(await revocation.isValidRoot(0n), false)
    assert.equal(await revocation.isValidRoot(revocation.mirror.root), true)
})
