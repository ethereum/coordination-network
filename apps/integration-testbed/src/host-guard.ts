import type { IncomingMessage, ServerResponse } from "node:http"

const ALLOWED_HOST = /^(localhost|\d{1,3}(\.\d{1,3}){3}|\[[0-9a-fA-F:.]+\])(:\d{1,5})?$/i

/**
 * Whether a `Host` header names an address a phone or a local tool would use: an IP literal, v4 or
 * bracketed v6, or `localhost`, with or without a port. A DNS name is what a rebinding page has to
 * use to get a browser to send this listener requests, so it is refused.
 */
export function isAllowedHost(host: string | undefined): boolean {
    return host !== undefined && ALLOWED_HOST.test(host)
}

/** Answers 421 and returns true when the request's `Host` is not one `isAllowedHost` accepts. */
export function refuseForeignHost(request: IncomingMessage, response: ServerResponse): boolean {
    if (isAllowedHost(request.headers.host)) return false

    request.resume()
    response.writeHead(421, { "content-type": "application/json" })
    response.end(JSON.stringify({ error: "misdirected request" }))
    return true
}
