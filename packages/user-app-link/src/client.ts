import { decodeResponse, encodeRequest } from "./codec"
import { LinkError } from "./errors"
import { resultSchemas } from "./schemas"
import type { Caller, LinkOp, LinkRequest, Params, Result } from "./types"

export interface LinkClientOptions {
    caller: Caller
    /** URL the user app opens with the response; must route back into this member app. */
    callback: string
    openUrl: (url: string) => Promise<void>
    /** Subscribes to incoming URLs (e.g. `Linking.addEventListener`); returns an unsubscribe function. */
    onUrl: (listener: (url: string) => void) => () => void
    /** Milliseconds before a request is abandoned. Default 120000. */
    timeoutMs?: number
    /** Overrides the request `id` generator; tests pass a deterministic one. */
    randomId?: () => string
    scheme?: string
}

export interface LinkClient {
    request<Op extends LinkOp>(op: Op, params: Params<Op>): Promise<Result<Op>>
}

const DEFAULT_TIMEOUT_MS = 120_000

function defaultRandomId(): string {
    const cryptoObj = globalThis.crypto
    if (typeof cryptoObj?.randomUUID === "function") {
        return cryptoObj.randomUUID()
    }

    const bytes = new Uint8Array(16)
    cryptoObj.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

interface PendingRequest {
    id: string
    op: LinkOp
    resolve: (result: unknown) => void
    reject: (error: unknown) => void
    unsubscribe: () => void
    timer: ReturnType<typeof setTimeout>
}

/** One member-app-side client per callback URL: exactly one request in flight, matched by id. */
export function createLinkClient(options: LinkClientOptions): LinkClient {
    const randomId = options.randomId ?? defaultRandomId
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let pending: PendingRequest | null = null

    // Handles a stray/duplicate/unrelated URL (pending already cleared, or some other deep link)
    // by returning early; every other exit clears `pending` itself rather than sharing a "settle"
    // helper, since by the time those exits run they already hold their own non-null references.
    function handleUrl(url: string): void {
        if (!pending) {
            return
        }

        let response
        try {
            response = decodeResponse(url)
        } catch {
            return // Not a response this client understands - some other deep link, ignore it.
        }

        if (response.id !== pending.id) {
            return // A response to a different (already-settled or stale) request.
        }

        const { op, resolve, reject, timer, unsubscribe } = pending
        pending = null
        clearTimeout(timer)
        unsubscribe()

        if (response.ok) {
            // Mirrors handler.ts's own check on the responder side: a result that decoded fine but
            // has the wrong shape for its op is a responder bug, not a transport glitch.
            const parsedResult = resultSchemas[op].safeParse(response.result)
            if (parsedResult.success) {
                resolve(parsedResult.data)
            } else {
                reject(new LinkError("INTERNAL", `response result failed its schema: ${parsedResult.error.message}`))
            }
        } else {
            reject(new LinkError(response.code, response.message))
        }
    }

    return {
        request<Op extends LinkOp>(op: Op, params: Params<Op>): Promise<Result<Op>> {
            if (pending) {
                return Promise.reject(new Error("createLinkClient: a request is already in flight"))
            }

            return new Promise<Result<Op>>((resolve, reject) => {
                // randomId/encodeRequest can throw (a caller-supplied randomId, a callback failing
                // its own schema, an oversized payload); thrown here, before resolve/reject has
                // been called, it rejects this promise automatically instead of escaping request()
                // as a synchronous throw.
                const id = randomId()
                // op and params are correlated by this call's own Op, but a deferred conditional
                // type like LinkRequest<Op> doesn't resolve for an unsubstituted generic - assert
                // it here.
                const request = {
                    id,
                    version: "v1",
                    caller: options.caller,
                    callback: options.callback,
                    op,
                    params
                } as LinkRequest<Op>
                const url = encodeRequest(request, { scheme: options.scheme })

                const unsubscribe = options.onUrl(handleUrl)
                const timer = setTimeout(() => {
                    pending = null
                    unsubscribe()
                    reject(new Error(`createLinkClient: request timed out after ${timeoutMs}ms`))
                }, timeoutMs)

                // resolve only ever receives this call's own response, matched by id in handleUrl above;
                // the cast to `(result: unknown) => void` just erases that per-call Op for storage below.
                pending = { id, op, resolve: resolve as (result: unknown) => void, reject, unsubscribe, timer }

                options.openUrl(url).catch((error: unknown) => {
                    pending = null
                    clearTimeout(timer)
                    unsubscribe()
                    reject(error)
                })
            })
        }
    }
}
