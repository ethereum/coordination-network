import { timingSafeEqual } from "node:crypto"
import type { NextFunction, Request, Response } from "express"
import { config } from "./config.ts"

const BEARER_PREFIX = "Bearer "

/**
 * The API is internal: only the network member's own backend calls it, with a shared token.
 */
export function requireAuthToken(request: Request, response: Response, next: NextFunction) {
    const authorizationHeader = request.get("authorization") ?? ""
    const callerToken = authorizationHeader.startsWith(BEARER_PREFIX)
        ? Buffer.from(authorizationHeader.slice(BEARER_PREFIX.length))
        : Buffer.alloc(0)
    const configuredToken = Buffer.from(config.authToken)

    // Compared in constant time so a wrong token leaks nothing about how much of it was right.
    if (callerToken.length !== configuredToken.length || !timingSafeEqual(callerToken, configuredToken)) {
        response.status(401).json({ error: "invalid auth token" })
        return
    }

    next()
}
