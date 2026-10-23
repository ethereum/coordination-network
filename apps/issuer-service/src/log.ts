/** Keeps only viem's `shortMessage`: its `message`/`stack` carry call args, request body and RPC URL.
 *  Duck-typed: `hoistingLimits: workspaces` gives this app its own viem copy, so `instanceof` misses the client's.
 *  Masks hex of 32+ bytes: a networkId, or a tx or userOp hash that resolves on chain to one. */
export function describeError(error: unknown, { stack = false } = {}): string {
    return describe(error, stack).replace(/0x[0-9a-fA-F]{64,}/g, "0x<redacted>")
}

function describe(error: unknown, stack: boolean): string {
    if (!(error instanceof Error)) return typeof error
    if (!("shortMessage" in error && typeof error.shortMessage === "string")) {
        return (stack && error.stack) || `${error.name}: ${error.message}`
    }
    // viem's stack header repeats the full message, so only its frames are kept.
    const frames = stack ? (error.stack?.match(/\n {4}at [\s\S]*/)?.[0] ?? "") : ""
    return `${error.name}: ${error.shortMessage}${frames}`
}
