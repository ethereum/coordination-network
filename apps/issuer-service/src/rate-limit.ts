import { RequestHandler } from "express"

const WINDOW_MS = 60_000

/**
 * A fixed 60s window shared by every request through this instance: one instance per route,
 * mounted after `requireMemberServerToken` so an unauthenticated flood can't spend the member's
 * own budget. Per process, not per caller - there is one shared token, so per-token is the same
 * thing, and per-IP can be forged.
 *
 * Defaults to `performance.now`, a monotonic clock, so an NTP sync or manual clock change can't
 * stretch or shorten the window.
 */
export function rateLimit(perMinute: number, now: () => number = () => performance.now()): RequestHandler {
    let windowStart = now()
    let count = 0

    return (_req, res, next) => {
        const current = now()
        if (current - windowStart >= WINDOW_MS) {
            windowStart = current
            count = 0
        }
        count++
        if (count > perMinute) {
            res.setHeader("Retry-After", String(Math.ceil((windowStart + WINDOW_MS - current) / 1000)))
            res.status(429).json({ error: "rate limit exceeded", code: "RATE_LIMITED" })
            return
        }
        next()
    }
}
