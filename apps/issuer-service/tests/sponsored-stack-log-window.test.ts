import assert from "node:assert/strict"
import { test } from "node:test"
import { createPublicClient, http } from "viem"
import { Identity } from "@semaphore-protocol/identity"
import { connectSponsoredStack } from "../src/sponsored-stack"
import { CHAIN_ID, RPC_URL, SPONSORED, mockSponsoredRpc, uintResult } from "./sponsored-rpc"

const FROM_BLOCK = 5
const HEAD = 25n
const EVENT_TYPES = 4

async function paymasterScan(logWindowBlocks?: number): Promise<string[]> {
    const rpc = mockSponsoredRpc({ blockNumber: HEAD, onCall: () => uintResult(0n) })
    try {
        const { paymasterGroup } = await connectSponsoredStack({
            sponsored: { ...SPONSORED, paymasterGroupFromBlock: FROM_BLOCK, logWindowBlocks },
            chainId: CHAIN_ID,
            identity: new Identity("sponsored-stack-log-window"),
            publicClient: createPublicClient({ transport: http(RPC_URL) })
        })
        // The mock chain holds no membership events, so the mirror rejects once it has read them all.
        await paymasterGroup.currentGroup().catch(() => undefined)
        return rpc.logRanges
    } finally {
        rpc.restore()
    }
}

test("the paymaster group mirror reads each event type in windows when logWindowBlocks is set", async () => {
    const ranges = await paymasterScan(10)

    assert.deepEqual(
        [...ranges].sort(),
        ["5-14", "15-24", "25-25"].flatMap((window) => Array<string>(EVENT_TYPES).fill(window)).sort()
    )
})

test("the paymaster group mirror reads each event type in one call when logWindowBlocks is unset", async () => {
    assert.deepEqual(await paymasterScan(), Array<string>(EVENT_TYPES).fill("5-25"))
})

test("the relay keeps the raw client", async () => {
    const rpc = mockSponsoredRpc()
    try {
        const publicClient = createPublicClient({ transport: http(RPC_URL) })
        const params = await connectSponsoredStack({
            sponsored: { ...SPONSORED, logWindowBlocks: 10 },
            chainId: CHAIN_ID,
            identity: new Identity("sponsored-stack-log-window"),
            publicClient
        })

        assert.equal(params.publicClient, publicClient)
    } finally {
        rpc.restore()
    }
})
