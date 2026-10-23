import type { PublicClient } from "viem"

type LogsClient = Pick<PublicClient, "getBlockNumber" | "getLogs" | "readContract">

function assertPositiveWindow(windowBlocks: bigint): void {
    if (windowBlocks < 1n) throw new Error(`log window must be at least 1 block, got ${windowBlocks}`)
}

export function withLogWindow(client: LogsClient, logWindowBlocks?: number): LogsClient {
    return logWindowBlocks === undefined ? client : windowedLogsClient(client, BigInt(logWindowBlocks))
}

/**
 * Wraps `client` so a block-range `getLogs` becomes several requests of at most `windowBlocks`
 * blocks each. Public RPC providers cap the block span of one `eth_getLogs`; a local node doesn't.
 * Only a numeric `fromBlock` with a numeric, absent or `"latest"` `toBlock` is windowed; a
 * `blockHash` query or any other block tag passes through untouched.
 */
export function windowedLogsClient(client: LogsClient, windowBlocks: bigint): LogsClient {
    assertPositiveWindow(windowBlocks)
    const getLogs = async (params?: Parameters<PublicClient["getLogs"]>[0]) => {
        if (typeof params?.fromBlock !== "bigint") return client.getLogs(params)
        const { toBlock } = params
        if (toBlock !== undefined && toBlock !== "latest" && typeof toBlock !== "bigint") return client.getLogs(params)

        // cacheTime 0: a caller that just sent a transaction must not be served viem's cached height.
        const to = typeof toBlock === "bigint" ? toBlock : await client.getBlockNumber({ cacheTime: 0 })
        const logs = []
        for (let from = params.fromBlock; from <= to; from += windowBlocks) {
            const end = from + windowBlocks - 1n < to ? from + windowBlocks - 1n : to
            // Not push(...): a busy window would exceed the engine's argument limit.
            for (const log of await client.getLogs({ ...params, fromBlock: from, toBlock: end })) logs.push(log)
        }
        return logs
    }
    return {
        getBlockNumber: client.getBlockNumber,
        readContract: client.readContract,
        // viem's getLogs is generic over the event; the wrapper's concrete signature isn't assignable to it without the cast.
        getLogs: getLogs as LogsClient["getLogs"]
    }
}

/**
 * View of one event's logs from `fromBlock`. With `confirmations` set, each `sync` fetches only
 * the blocks past the last scan, so tailing a chain costs the new blocks rather than its history;
 * without it, each `sync` rescans from `fromBlock`. Syncs run one after another, so concurrent
 * callers never fetch the same range twice. A failed window leaves earlier ones scanned and the next
 * `sync` resumes at the failed one. Logs are kept for good, so `confirmations` holds the scan that
 * many blocks behind the head, out of reorg reach.
 */
export class EventLogIndex<TLog> {
    private readonly logs: TLog[] = []
    private scannedTo: bigint
    private tail: Promise<unknown> = Promise.resolve()

    constructor(
        private readonly options: {
            fromBlock: bigint
            fetch: (from: bigint, to: bigint) => Promise<TLog[]>
            windowBlocks?: bigint
            confirmations?: bigint
        }
    ) {
        if (options.windowBlocks !== undefined) assertPositiveWindow(options.windowBlocks)
        // A negative lag would scan past the head and mark those blocks scanned, skipping them for good.
        if ((options.confirmations ?? 0n) < 0n) {
            throw new Error(`log confirmations must not be negative, got ${options.confirmations}`)
        }
        this.scannedTo = options.fromBlock - 1n
    }

    sync(head: bigint): Promise<readonly TLog[]> {
        const result = this.tail.then(() => this.scan(head))
        this.tail = result.catch(() => undefined)
        return result
    }

    private async scan(head: bigint): Promise<readonly TLog[]> {
        const { fromBlock, fetch, windowBlocks, confirmations } = this.options
        // Behind a load-balanced RPC the node serving getLogs can trail the one that gave the head,
        // so without a lag a scan could mark unserved blocks as done. Rescan instead.
        if (confirmations === undefined) {
            this.logs.length = 0
            this.scannedTo = fromBlock - 1n
        }
        const target = head - (confirmations ?? 0n)
        const span = windowBlocks ?? target - this.scannedTo
        while (this.scannedTo < target) {
            const from = this.scannedTo + 1n
            const to = from + span - 1n < target ? from + span - 1n : target
            // Not push(...): a busy window would exceed the engine's argument limit.
            for (const log of await fetch(from, to)) this.logs.push(log)
            this.scannedTo = to
        }
        return this.logs.slice()
    }
}
