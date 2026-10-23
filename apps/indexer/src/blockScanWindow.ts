import { InvalidParamsRpcError, LimitExceededRpcError } from "viem"

/** True when the RPC rejected a getLogs call because the block scan window covered too many blocks. */
export function isBlockScanWindowTooLargeError(error: unknown): boolean {
    if (error instanceof InvalidParamsRpcError || error instanceof LimitExceededRpcError) return true
    // there is no standard error code for this, but most RPCs name the range or size
    return (
        error instanceof Error &&
        /block range|blocks range|response size|log size|query returned more/i.test(error.message)
    )
}

/** The last block of the current window. Covers `blockScanWindowSize` blocks, never passing `lastBlock`. */
export function blockScanWindowEnd(fromBlock: bigint, lastBlock: bigint, blockScanWindowSize: number): bigint {
    const toBlock = fromBlock + BigInt(blockScanWindowSize) - 1n
    return toBlock < lastBlock ? toBlock : lastBlock
}

/** Halves the block scan window after the RPC rejected it. Never drops below one block. */
export function shrinkBlockScanWindow(blockScanWindowSize: number): number {
    return Math.max(1, Math.floor(blockScanWindowSize / 2))
}

/** Grows the block scan window 5% after a successful scan, up to the configured max. */
export function growBlockScanWindow(blockScanWindowSize: number, maxBlockScanWindowSize: number): number {
    return Math.min(maxBlockScanWindowSize, Math.ceil(blockScanWindowSize * 1.05))
}
