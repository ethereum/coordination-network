import type { LinkErrorCode } from "./types"

/** A link-protocol failure, discriminated by the same `code` a wire `{ ok: false }` response carries. */
export class LinkError extends Error {
    readonly code: LinkErrorCode

    constructor(code: LinkErrorCode, message?: string) {
        super(message ?? code)
        this.name = "LinkError"
        this.code = code
    }
}

/** Thrown by encodeRequest/encodeResponse when the built URL exceeds MAX_URL_LENGTH. */
export class LinkPayloadTooLargeError extends LinkError {
    constructor(message: string) {
        super("INVALID_REQUEST", message)
        this.name = "LinkPayloadTooLargeError"
    }
}

/**
 * Thrown by decodeRequest/decodeResponse when a URL can't be decoded into a well-formed v1
 * envelope - the only failure this package ever throws rather than turning into an `ok: false`
 * response, because without a valid `id`/`callback` there is nowhere to send that response.
 */
export class LinkDecodeError extends LinkError {
    constructor(message: string) {
        super("INVALID_REQUEST", message)
        this.name = "LinkDecodeError"
    }
}
