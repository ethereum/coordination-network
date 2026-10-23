import type { Check, TestDetail } from "./types"

/** Formats a caught value for display: an `Error`'s `message`, or `String(value)` for anything else. */
export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}

/** Builds a single {@link Check}. */
export function check(label: string, ok: boolean, detail?: string): Check {
    return detail === undefined ? { label, ok } : { label, ok, detail }
}

/**
 * Builds a {@link TestDetail}: `ok` is derived from the checks, `ms` from `start`
 * (a `performance.now()` reading taken at the top of `run()`).
 */
export function finish(start: number, checks: Check[], note?: string): TestDetail {
    const ok = checks.every((entry) => entry.ok)
    const ms = performance.now() - start

    return note === undefined ? { ok, ms, checks } : { ok, ms, checks, note }
}
