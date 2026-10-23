import { z } from "zod"
import { describeError } from "../log"

export interface StatusList {
    /** Every listed serial, lowercase hex without leading zeros; an all-digit key under both readings. */
    serials: ReadonlySet<string>
    fetchedAt: number
}

export type StatusListState = "fresh" | "stale" | "never-fetched"

export type StatusListSnapshot = StatusList | { unavailable: Exclude<StatusListState, "fresh"> }

export interface StatusListSource {
    snapshot(): StatusListSnapshot
}

export interface StatusListCache extends StatusListSource {
    /** Resolves once the first fetch settles, true when it produced a list. */
    start(): Promise<boolean>
    stop(): void
}

export interface StatusListCacheOptions {
    fetch?: typeof globalThis.fetch
    url: string
    now?: () => number
    maxStaleMs?: number
    refreshMinMs?: number
    refreshMaxMs?: number
    timeoutMs?: number
    maxBytes?: number
    log?: (message: string) => void
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const BACKOFF_MIN_MS = MINUTE
const BACKOFF_MAX_MS = 30 * MINUTE

// Google lists REVOKED and SUSPENDED entries. Any listed serial fails, so a status this does not
// know cannot let a certificate through.
const statusFile = z.object({
    entries: z.record(z.string().regex(/^[0-9a-fA-F]+$/), z.looseObject({ status: z.string().min(1) }))
})

/** Throws on a malformed or empty list, so a broken response never replaces a good one. */
export function parseStatusList(json: unknown): ReadonlySet<string> {
    const keys = Object.keys(statusFile.parse(json).entries)
    if (keys.length === 0) throw new Error("empty status list")
    return new Set(keys.flatMap(readings))
}

// Most keys are hex, but Google's all-digit keys all fit 64 bits read as decimal, so those are likely
// factory serials in decimal. Some factory serials are all digits in hex too, so both readings count.
function readings(key: string): string[] {
    const hex = BigInt(`0x${key}`).toString(16)
    return /^[0-9]+$/.test(key) ? [hex, BigInt(key).toString(16)] : [hex]
}

/**
 * Keeps Google's attestation status list in memory. A failed refresh keeps the last good copy
 * until it is `maxStaleMs` old, then the snapshot turns unavailable and issuance stops.
 */
export function createStatusListCache({
    fetch = globalThis.fetch,
    url,
    now = Date.now,
    maxStaleMs = 72 * HOUR,
    refreshMinMs = 15 * MINUTE,
    refreshMaxMs = 24 * HOUR,
    timeoutMs = 10_000,
    maxBytes = 2 * 1024 * 1024,
    log = console.warn
}: StatusListCacheOptions): StatusListCache {
    let current: StatusList | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let stopped = false
    // Fetching at least twice per staleness limit keeps a list that loads from going stale between fetches.
    const halfStaleMs = maxStaleMs / 2
    const refreshCeilingMs = Math.min(refreshMaxMs, halfStaleMs)
    const refreshFloorMs = Math.min(refreshMinMs, refreshCeilingMs)

    function schedule(delayMs: number) {
        if (stopped) return
        timer = setTimeout(() => void refresh(), delayMs)
        timer.unref()
    }

    async function refresh(): Promise<boolean> {
        try {
            const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const serials = parseStatusList(JSON.parse(await readCapped(response, maxBytes)))
            current = { serials, fetchedAt: now() }
            failures = 0
            schedule(Math.min(Math.max(maxAgeMs(response.headers), refreshFloorMs), refreshCeilingMs))
            return true
        } catch (error) {
            failures += 1
            log(`device attestation status list refresh failed: ${describeError(error)}`)
            schedule(Math.min(BACKOFF_MIN_MS * 2 ** (failures - 1), BACKOFF_MAX_MS, halfStaleMs))
            return false
        }
    }

    return {
        start: refresh,
        stop() {
            stopped = true
            clearTimeout(timer)
        },
        snapshot() {
            if (!current) return { unavailable: "never-fetched" }
            if (now() - current.fetchedAt > maxStaleMs) return { unavailable: "stale" }
            return current
        }
    }
}

/** No max-age refreshes at the floor. */
function maxAgeMs(headers: Headers): number {
    const maxAge = headers.get("cache-control")?.match(/(?:^|[,\s])max-age=(\d+)/)?.[1]
    return maxAge === undefined ? 0 : Number(maxAge) * 1000
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
    if (Number(response.headers.get("content-length") ?? 0) > maxBytes) throw new Error("status list too large")
    const chunks: Uint8Array[] = []
    let size = 0
    if (response.body) {
        const reader = response.body.getReader()
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
            size += read.value.byteLength
            if (size > maxBytes) {
                await reader.cancel()
                throw new Error("status list too large")
            }
            chunks.push(read.value)
        }
    }
    return Buffer.concat(chunks).toString("utf8")
}
