import { decodeRequest, encodeResponse } from "./codec"
import { LinkError } from "./errors"
import { LINK_ERROR_MESSAGES } from "./messages"
import { paramsSchemas, resultSchemas } from "./schemas"
import {
    LINK_OPS,
    type Caller,
    type DecodedLinkRequest,
    type LinkErrorCode,
    type LinkHandlers,
    type LinkOp,
    type LinkResponse
} from "./types"

export interface RequestHandlerOptions {
    handlers: LinkHandlers
    /** Shows the user what's being requested and by whom; resolves to whether they approved it. */
    consent: (request: DecodedLinkRequest) => Promise<boolean>
}

export interface RequestHandler {
    /** Decodes and dispatches `url`, returning the response URL to open. Never rejects except on {@link LinkDecodeError}. */
    handle(url: string): Promise<string>
}

function isLinkOp(op: string): op is LinkOp {
    return (LINK_OPS as readonly string[]).includes(op)
}

/** A zod error can name every unrecognized key in a params object, easily blowing the response URL's budget. */
const MAX_RESPONSE_MESSAGE_LENGTH = 256

/**
 * Dispatch is inherently dynamic (the op comes from the decoded URL, not a type parameter), so the
 * per-op correlation `LinkHandlers` gives callers has to be widened away here rather than threaded through.
 */
type AnyLinkHandler = (params: unknown, context: { caller: Caller }) => Promise<unknown>

export function createRequestHandler(options: RequestHandlerOptions): RequestHandler {
    const { handlers, consent } = options

    function respond(
        request: DecodedLinkRequest,
        code: LinkErrorCode,
        message: string = LINK_ERROR_MESSAGES[code]
    ): string {
        const cappedMessage = message.slice(0, MAX_RESPONSE_MESSAGE_LENGTH)
        return encodeResponse(request.callback, {
            id: request.id,
            version: "v1",
            ok: false,
            code,
            message: cappedMessage
        })
    }

    return {
        async handle(url: string): Promise<string> {
            const request = decodeRequest(url)

            if (!isLinkOp(request.op)) {
                return respond(request, "UNSUPPORTED_OP")
            }

            const handler = handlers[request.op] as AnyLinkHandler | undefined
            if (!handler) {
                return respond(request, "UNSUPPORTED_OP")
            }

            const parsedParams = paramsSchemas[request.op].safeParse(request.params)
            if (!parsedParams.success) {
                return respond(request, "INVALID_REQUEST", parsedParams.error.message)
            }

            if (!(await consent(request))) {
                return respond(request, "USER_DENIED")
            }

            try {
                const result = await handler(parsedParams.data, { caller: request.caller })

                // A handler's return type isn't checked against Result<Op> at compile time
                // (AnyLinkHandler erased that), so a wrong shape here is a bug in this app's own
                // handler, not the caller's fault - report it as INTERNAL, not INVALID_REQUEST.
                const parsedResult = resultSchemas[request.op].safeParse(result)
                if (!parsedResult.success) {
                    return respond(request, "INTERNAL")
                }

                const response = { id: request.id, version: "v1", ok: true, result: parsedResult.data } as LinkResponse
                return encodeResponse(request.callback, response)
            } catch (error) {
                if (error instanceof LinkError) {
                    return respond(request, error.code)
                }
                return respond(request, "INTERNAL")
            }
        }
    }
}
