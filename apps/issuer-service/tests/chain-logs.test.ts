import assert from "node:assert/strict"
import { test } from "node:test"
import { parseAbiItem } from "viem"
import type { PublicClient } from "viem"
import { EventLogIndex, windowedLogsClient } from "../src/chain-logs"

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)")

type Range = [bigint, bigint]

/** A client whose `getLogs` records each request and answers one log per call. */
function fakeClient(head: bigint) {
    const headReads: unknown[] = []
    const requests: { fromBlock?: bigint | "latest"; toBlock?: bigint | "latest" }[] = []
    const client = {
        getBlockNumber: async (params?: unknown) => {
            headReads.push(params)
            return head
        },
        readContract: async () => 7n,
        getLogs: async (params: (typeof requests)[number]) => {
            requests.push(params)
            return [{ blockNumber: params.fromBlock }]
        }
    } as unknown as PublicClient
    const ranges = () => requests.map(({ fromBlock, toBlock }) => [fromBlock, toBlock])
    return { client, requests, ranges, headReads }
}

test("windowedLogsClient splits a range into inclusive windows and concatenates the logs", async () => {
    const { client, ranges } = fakeClient(100n)

    const logs = await windowedLogsClient(client, 10n).getLogs({ event: TRANSFER, fromBlock: 0n, toBlock: 29n })

    assert.deepEqual(ranges(), [
        [0n, 9n],
        [10n, 19n],
        [20n, 29n]
    ])
    assert.equal(logs.length, 3)
})

test("windowedLogsClient ends on the remainder and handles a single block", async () => {
    const { client, ranges } = fakeClient(100n)
    const windowed = windowedLogsClient(client, 10n)

    await windowed.getLogs({ event: TRANSFER, fromBlock: 5n, toBlock: 24n })
    await windowed.getLogs({ event: TRANSFER, fromBlock: 40n, toBlock: 40n })

    assert.deepEqual(ranges(), [
        [5n, 14n],
        [15n, 24n],
        [40n, 40n]
    ])
})

test("windowedLogsClient resolves a missing or latest toBlock through getBlockNumber", async () => {
    const { client, ranges } = fakeClient(12n)
    const windowed = windowedLogsClient(client, 10n)

    await windowed.getLogs({ event: TRANSFER, fromBlock: 0n })
    await windowed.getLogs({ event: TRANSFER, fromBlock: 10n, toBlock: "latest" })

    assert.deepEqual(ranges(), [
        [0n, 9n],
        [10n, 12n],
        [10n, 12n]
    ])
})

test("windowedLogsClient passes a request with no fromBlock through unchanged", async () => {
    const { client, requests } = fakeClient(100n)
    const request = { event: TRANSFER }

    await windowedLogsClient(client, 10n).getLogs(request)

    assert.deepEqual(requests, [request])
})

test("windowedLogsClient passes getBlockNumber and readContract straight through", async () => {
    const { client } = fakeClient(55n)
    const windowed = windowedLogsClient(client, 10n)

    assert.equal(await windowed.getBlockNumber(), 55n)
    assert.equal(await windowed.readContract({} as never), 7n)
})

function fakeIndex(windowBlocks?: bigint) {
    const ranges: Range[] = []
    const index = new EventLogIndex<Range>({
        fromBlock: 5n,
        windowBlocks,
        confirmations: 0n,
        fetch: async (from, to) => {
            ranges.push([from, to])
            return [[from, to]]
        }
    })
    return { index, ranges }
}

test("EventLogIndex scans from fromBlock to head and returns every log", async () => {
    const { index, ranges } = fakeIndex()

    const logs = await index.sync(20n)

    assert.deepEqual(ranges, [[5n, 20n]])
    assert.deepEqual(logs, [[5n, 20n]])
})

test("EventLogIndex fetches only the new blocks on a later sync", async () => {
    const { index, ranges } = fakeIndex()

    await index.sync(20n)
    const logs = await index.sync(25n)

    assert.deepEqual(ranges, [
        [5n, 20n],
        [21n, 25n]
    ])
    assert.equal(logs.length, 2)
})

test("EventLogIndex fetches nothing when the head has not moved", async () => {
    const { index, ranges } = fakeIndex()

    await index.sync(20n)
    await index.sync(20n)
    await index.sync(3n)

    assert.equal(ranges.length, 1)
})

test("EventLogIndex scans in windows when windowBlocks is set", async () => {
    const { index, ranges } = fakeIndex(10n)

    await index.sync(30n)

    assert.deepEqual(ranges, [
        [5n, 14n],
        [15n, 24n],
        [25n, 30n]
    ])
})

test("EventLogIndex serializes concurrent syncs so no range is fetched twice", async () => {
    const { index, ranges } = fakeIndex()

    const [first, second] = await Promise.all([index.sync(20n), index.sync(20n)])

    assert.equal(ranges.length, 1)
    assert.deepEqual(first, second)
})

test("EventLogIndex scans a later head only past the range an in-flight sync already covers", async () => {
    const ranges: Range[] = []
    let release: () => void = () => {}
    const firstFetch = new Promise<void>((resolve) => {
        release = resolve
    })
    const index = new EventLogIndex<Range>({
        fromBlock: 5n,
        confirmations: 0n,
        fetch: async (from, to) => {
            ranges.push([from, to])
            if (ranges.length === 1) await firstFetch
            return []
        }
    })

    const first = index.sync(20n)
    const second = index.sync(25n)
    release()
    await Promise.all([first, second])

    assert.deepEqual(ranges, [
        [5n, 20n],
        [21n, 25n]
    ])
})

test("EventLogIndex resumes after a failed window without refetching earlier ones", async () => {
    const ranges: Range[] = []
    let failNext = true
    const index = new EventLogIndex<Range>({
        fromBlock: 0n,
        windowBlocks: 10n,
        confirmations: 0n,
        fetch: async (from, to) => {
            if (from === 10n && failNext) {
                failNext = false
                throw new Error("rpc down")
            }
            ranges.push([from, to])
            return [[from, to]]
        }
    })

    await assert.rejects(index.sync(19n), /rpc down/)
    const logs = await index.sync(19n)

    assert.deepEqual(ranges, [
        [0n, 9n],
        [10n, 19n]
    ])
    assert.equal(logs.length, 2)
})

test("EventLogIndex with confirmations scans only blocks that many behind the head", async () => {
    const ranges: Range[] = []
    const index = new EventLogIndex<Range>({
        fromBlock: 0n,
        confirmations: 2n,
        fetch: async (from, to) => {
            ranges.push([from, to])
            return []
        }
    })

    await index.sync(10n)
    await index.sync(11n)
    await index.sync(11n)
    await index.sync(1n)

    assert.deepEqual(ranges, [
        [0n, 8n],
        [9n, 9n]
    ])
})

test("windowedLogsClient refuses a window that cannot advance", () => {
    const { client } = fakeClient(100n)

    assert.throws(() => windowedLogsClient(client, 0n), /window.*0/)
    assert.throws(() => windowedLogsClient(client, -5n), /window.*-5/)
})

test("EventLogIndex refuses a window that cannot advance", () => {
    const fetch = async () => []

    assert.throws(() => new EventLogIndex({ fromBlock: 0n, fetch, windowBlocks: 0n }), /window.*0/)
})

test("windowedLogsClient resolves the head past viem's block-number cache", async () => {
    const { client, headReads } = fakeClient(12n)

    await windowedLogsClient(client, 10n).getLogs({ event: TRANSFER, fromBlock: 0n })

    assert.deepEqual(headReads, [{ cacheTime: 0 }])
})

test("windowedLogsClient leaves a request ending at a block tag other than latest to the provider", async () => {
    const { client, requests } = fakeClient(100n)
    const windowed = windowedLogsClient(client, 10n)
    const sent = (["safe", "finalized", "earliest", "pending"] as const).map((toBlock) => ({
        event: TRANSFER,
        fromBlock: 0n,
        toBlock
    }))

    for (const request of sent) await windowed.getLogs(request)

    assert.deepEqual(requests, sent)
})

test("windowedLogsClient concatenates a window too large to spread as call arguments", async () => {
    const client = {
        getBlockNumber: async () => 5n,
        readContract: async () => 7n,
        getLogs: async () => Array.from({ length: 200_000 }, () => ({}))
    } as unknown as PublicClient

    const logs = await windowedLogsClient(client, 10n).getLogs({ event: TRANSFER, fromBlock: 0n })

    assert.equal(logs.length, 200_000)
})

test("EventLogIndex appends a window too large to spread as call arguments", async () => {
    const index = new EventLogIndex<object>({
        fromBlock: 0n,
        fetch: async () => Array.from({ length: 200_000 }, () => ({}))
    })

    assert.equal((await index.sync(5n)).length, 200_000)
})

test("EventLogIndex windows the scan up to the confirmed head", async () => {
    const ranges: Range[] = []
    const index = new EventLogIndex<Range>({
        fromBlock: 0n,
        windowBlocks: 3n,
        confirmations: 2n,
        fetch: async (from, to) => {
            ranges.push([from, to])
            return []
        }
    })

    await index.sync(10n)
    await index.sync(12n)

    assert.deepEqual(ranges, [
        [0n, 2n],
        [3n, 5n],
        [6n, 8n],
        [9n, 10n]
    ])
})

test("EventLogIndex refuses negative confirmations", () => {
    const fetch = async () => []

    assert.throws(() => new EventLogIndex({ fromBlock: 0n, fetch, confirmations: -1n }), /confirmations.*-1/)
})

test("EventLogIndex without confirmations rescans from fromBlock on every sync", async () => {
    const ranges: Range[] = []
    const index = new EventLogIndex<Range>({
        fromBlock: 5n,
        fetch: async (from, to) => {
            ranges.push([from, to])
            return [[from, to]]
        }
    })

    await index.sync(20n)
    const logs = await index.sync(25n)

    assert.deepEqual(ranges, [
        [5n, 20n],
        [5n, 25n]
    ])
    assert.deepEqual(logs, [[5n, 25n]])
})

test("EventLogIndex without confirmations returns a log its node served late", async () => {
    let served = false
    const index = new EventLogIndex<string>({
        fromBlock: 0n,
        fetch: async () => (served ? ["late"] : [])
    })

    assert.deepEqual(await index.sync(10n), [])
    served = true
    assert.deepEqual(await index.sync(10n), ["late"])
})
