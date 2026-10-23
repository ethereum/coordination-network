import assert from "node:assert/strict"
import { test } from "node:test"
import { decodeFunctionData, encodeAbiParameters, parseAbiParameters, toFunctionSelector, type Hex } from "viem"
import { ApprovedIssuerSet, LocalCredentialSigner } from "@coordination-network/credential"
import { buildChainIssuerSet, createInMemoryIssuerSet } from "../src/issuer-set"

const ISSUER_SET_ADDRESS = `0x${"cc".repeat(20)}` as const
const PINNED_BLOCK_TAG = "0x64"

const GET_LEAVES_ABI = [
    {
        type: "function",
        name: "getLeaves",
        stateMutability: "view",
        inputs: [
            { name: "start", type: "uint256" },
            { name: "end", type: "uint256" }
        ],
        outputs: [{ name: "leaves", type: "uint256[]" }]
    }
] as const

const GET_LEAF_COUNT_SELECTOR = toFunctionSelector("function getLeafCount() view returns (uint256)")
const GET_LEAVES_SELECTOR = toFunctionSelector(
    "function getLeaves(uint256 start, uint256 end) view returns (uint256[])"
)
const ISSUER_SET_ROOT_SELECTOR = toFunctionSelector("function issuerSetRoot() view returns (uint256)")
const GET_SIZE_SELECTOR = toFunctionSelector("function getSize() view returns (uint256)")

const uintResult = (value: bigint): Hex => `0x${value.toString(16).padStart(64, "0")}`
const leavesResult = (leaves: bigint[]): Hex => encodeAbiParameters(parseAbiParameters("uint256[]"), [leaves])

/**
 * Stands in for anvil for `buildChainIssuerSet`'s own reads: every `eth_call` this test cares about
 * answers from `leavesAtPinnedBlock` when the call is pinned to `PINNED_BLOCK_TAG` (what `read()`
 * captures from its own `eth_blockNumber` first), or from `leavesLatest` for any other block tag —
 * modelling a leaf published after that block was captured. `onCall` records every block tag seen.
 */
function mockRpc(
    leavesAtPinnedBlock: bigint[],
    leavesLatest: bigint[],
    onCall: (blockTag: string | undefined) => void
): () => void {
    const original = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { id: number; method: string; params: unknown[] }
        let result: unknown
        switch (body.method) {
            case "eth_blockNumber":
                result = PINNED_BLOCK_TAG
                break
            case "eth_call": {
                const [{ data }, blockTag] = body.params as [{ data: Hex }, string | undefined]
                onCall(blockTag)
                const leaves = blockTag === PINNED_BLOCK_TAG ? leavesAtPinnedBlock : leavesLatest

                if (data.startsWith(GET_LEAF_COUNT_SELECTOR)) {
                    result = uintResult(BigInt(leaves.length))
                } else if (data.startsWith(GET_LEAVES_SELECTOR)) {
                    const { args } = decodeFunctionData({ abi: GET_LEAVES_ABI, data })
                    const [start, end] = args
                    result = leavesResult(leaves.slice(Number(start), Number(end)))
                } else if (data.startsWith(ISSUER_SET_ROOT_SELECTOR)) {
                    result = uintResult(ApprovedIssuerSet.fromLeaves(leaves).root)
                } else if (data.startsWith(GET_SIZE_SELECTOR)) {
                    // No tombstones in this fixture: every leaf is live.
                    result = uintResult(BigInt(leaves.length))
                } else {
                    result = "0x"
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

test("createInMemoryIssuerSet reads the built set's own leaves and root, at block zero", async () => {
    const signer = new LocalCredentialSigner("issuer-set-inmemory")
    const key = await signer.getPublicKey()
    const backing = createInMemoryIssuerSet([key])

    const state = await backing.read()

    assert.equal(state.leaves.length, 1)
    assert.equal(state.blockNumber, 0n)
    assert.equal(await backing.isValidRoot(state.root), true)
    assert.equal(await backing.isValidRoot(state.root + 1n), false)
})

test("createInMemoryIssuerSet's leaves follow the keys' own order, extra keys included", async () => {
    const own = await new LocalCredentialSigner("issuer-set-inmemory-own").getPublicKey()
    const other = await new LocalCredentialSigner("issuer-set-inmemory-other").getPublicKey()
    const backing = createInMemoryIssuerSet([own, other])

    const state = await backing.read()

    assert.equal(state.leaves.length, 2)
    assert.notDeepEqual(state.leaves[0], state.leaves[1])
})

test("buildChainIssuerSet's read() pins every call to one block, so a leaf published between calls never mixes into the result", async () => {
    const blockTags: (string | undefined)[] = []
    const restore = mockRpc([111n], [111n, 222n], (blockTag) => blockTags.push(blockTag))
    try {
        const issuerSet = buildChainIssuerSet(ISSUER_SET_ADDRESS, "http://fake-rpc.test")

        const state = await issuerSet.read()

        assert.deepEqual(state.leaves, [111n])
        assert.equal(state.root, ApprovedIssuerSet.fromLeaves([111n]).root)
        // Every eth_call read() made was pinned to the same block it captured first: had any of
        // them gone unpinned, it would have read leavesLatest (222n included) instead.
        assert.ok(blockTags.length >= 4, `expected at least 4 eth_call reads, got ${blockTags.length}`)
        assert.ok(blockTags.every((tag) => tag === PINNED_BLOCK_TAG))
    } finally {
        restore()
    }
})

test("buildChainIssuerSet's read() pages getLeaves past one page's worth of leaves, all still pinned to one block", async () => {
    const PAGE_SIZE = 1000 // mirrors issuer-set.ts's own ISSUER_SET_PAGE_SIZE, not exported
    const leaves = Array.from({ length: PAGE_SIZE + 500 }, (_, index) => BigInt(index + 1))
    const blockTags: (string | undefined)[] = []
    const restore = mockRpc(leaves, leaves, (blockTag) => blockTags.push(blockTag))
    try {
        const issuerSet = buildChainIssuerSet(ISSUER_SET_ADDRESS, "http://fake-rpc.test")

        const state = await issuerSet.read()

        assert.deepEqual(state.leaves, leaves)
        assert.equal(state.root, ApprovedIssuerSet.fromLeaves(leaves).root)
        // getLeafCount + issuerSetRoot + getSize + (at least) two getLeaves pages.
        assert.ok(blockTags.length >= 5, `expected at least 5 eth_call reads, got ${blockTags.length}`)
        assert.ok(blockTags.every((tag) => tag === PINNED_BLOCK_TAG))
    } finally {
        restore()
    }
})
