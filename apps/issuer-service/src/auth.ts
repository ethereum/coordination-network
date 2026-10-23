import { timingSafeEqual } from "node:crypto"
import { RequestHandler } from "express"

/**
 * The bearer check in front of the routes that act as this organisation: the governance group,
 * the credential and verification-record reads, the revoke route, registration, delivery, and
 * the legacy admission router. Everything else a wallet calls stays open, since a holder has no
 * member server token and each of those routes carries a check of its own.
 *
 * No token means every caller passes. `buildServer` is what the Node scenarios and the route
 * tests mount, and making the token mandatory there would say nothing about a real deployment;
 * `loadConfig` is where the env-driven server is made to fail closed instead.
 */
export function requireMemberServerToken(token?: string): RequestHandler {
    if (!token) return (_req, _res, next) => next()

    const expected = Buffer.from(token, "utf8")
    return (req, res, next) => {
        const presented = /^Bearer (.+)$/.exec(req.header("authorization") ?? "")?.[1]
        const bytes = presented === undefined ? undefined : Buffer.from(presented, "utf8")
        // timingSafeEqual throws instead of answering when the lengths differ, so length is
        // compared first. It is the one thing about the token this leaks.
        if (!bytes || bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) {
            res.status(401).json({ error: "member server token required", code: "UNAUTHORIZED" })
            return
        }
        next()
    }
}
