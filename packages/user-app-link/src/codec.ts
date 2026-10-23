import { LinkDecodeError, LinkError, LinkPayloadTooLargeError } from "./errors"
import {
    callbackSchema,
    callerSchema,
    DENIED_CALLBACK_SCHEMES,
    linkRequestEnvelopeSchema,
    linkResponseSchema
} from "./schemas"
import type { DecodedLinkRequest, LinkOp, LinkRequest, LinkResponse } from "./types"

export const USER_APP_SCHEME = "userapp"

/** Above this, a platform's `Linking.openURL` (and some OSes) start truncating or refusing the URL. */
export const MAX_URL_LENGTH = 2000

/** Encodes bytes with the base64url alphabet (RFC 4648 §5), unpadded. No Node `Buffer`: `atob`/`btoa` only. */
export function base64UrlEncode(bytes: Uint8Array): string {
    let binary = ""
    for (const byte of bytes) {
        binary += String.fromCharCode(byte)
    }
    return globalThis.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function base64UrlDecode(value: string): Uint8Array {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/")
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")
    const binary = globalThis.atob(padded)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

function encodePayload(value: unknown): string {
    return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

function decodePayload(payload: string): unknown {
    try {
        return JSON.parse(new TextDecoder().decode(base64UrlDecode(payload)))
    } catch {
        throw new LinkDecodeError("payload is not valid base64url-encoded JSON")
    }
}

function checkUrlLength(url: string): void {
    if (url.length > MAX_URL_LENGTH) {
        throw new LinkPayloadTooLargeError(`link URL is ${url.length} characters, over the ${MAX_URL_LENGTH} limit`)
    }
}

/**
 * Reads a query parameter by hand rather than via the `URL`/`URLSearchParams` globals, which
 * Hermes (React Native's JS engine) doesn't provide without a polyfill.
 */
function getQueryParam(url: string, key: string): string | null {
    const queryIndex = url.indexOf("?")
    if (queryIndex === -1) {
        return null
    }
    for (const pair of url.slice(queryIndex + 1).split("&")) {
        const [rawKey, rawValue = ""] = pair.split("=")
        if (decodeURIComponent(rawKey) === key) {
            return decodeURIComponent(rawValue)
        }
    }
    return null
}

export function encodeRequest<Op extends LinkOp>(request: LinkRequest<Op>, options: { scheme?: string } = {}): string {
    const scheme = options.scheme ?? USER_APP_SCHEME
    // The request URL is built as `${scheme}://...`, so a `?`/`#` in scheme would corrupt it the
    // same way a bad callback corrupts the response URL below.
    if (scheme.includes("?") || scheme.includes("#")) {
        throw new LinkError("INVALID_REQUEST", "scheme must not contain a query string or fragment")
    }
    if ((DENIED_CALLBACK_SCHEMES as readonly string[]).includes(scheme.toLowerCase())) {
        throw new LinkError("INVALID_REQUEST", `scheme must not be one of: ${DENIED_CALLBACK_SCHEMES.join(", ")}`)
    }
    const parsedCaller = callerSchema.safeParse(request.caller)
    if (!parsedCaller.success) {
        // Otherwise a caller decodeRequest's own callerSchema would refuse (too long a name, say)
        // gets a URL the user app can't decode, and the member app just waits out its own timeout.
        throw new LinkError("INVALID_REQUEST", `caller ${parsedCaller.error.issues[0].message}`)
    }
    const parsedCallback = callbackSchema.safeParse(request.callback)
    if (!parsedCallback.success) {
        // Surfaces callbackSchema's own issue message so a denied scheme and a query
        // string/fragment report distinct reasons instead of one hardcoded message for both.
        throw new LinkError("INVALID_REQUEST", `callback ${parsedCallback.error.issues[0].message}`)
    }

    const url = `${scheme}://v1/request?payload=${encodePayload(request)}`
    checkUrlLength(url)
    return url
}

export function decodeRequest(url: string): DecodedLinkRequest {
    const payload = getQueryParam(url, "payload")
    if (payload === null) {
        throw new LinkDecodeError("link URL is missing the payload query parameter")
    }

    const parsed = linkRequestEnvelopeSchema.safeParse(decodePayload(payload))
    if (!parsed.success) {
        throw new LinkDecodeError(`malformed request payload: ${parsed.error.message}`)
    }

    return parsed.data
}

export function encodeResponse<Op extends LinkOp>(callback: string, response: LinkResponse<Op>): string {
    const url = `${callback}?payload=${encodePayload(response)}`
    checkUrlLength(url)
    return url
}

export function decodeResponse(url: string): LinkResponse {
    const payload = getQueryParam(url, "payload")
    if (payload === null) {
        throw new LinkDecodeError("link URL is missing the payload query parameter")
    }

    const parsed = linkResponseSchema.safeParse(decodePayload(payload))
    if (!parsed.success) {
        throw new LinkDecodeError(`malformed response payload: ${parsed.error.message}`)
    }

    // The envelope carries no `op`, so the schema can only prove `result` is present, not which
    // op's shape it has - the caller (client.ts) knows that from the id it matches the response to.
    return parsed.data as LinkResponse
}
