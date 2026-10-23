import { Hex, RegistrationRequest, RegistrationSubmitter, SubmissionReceipt } from "./types"
import { hexToBytes } from "./bytes"
import { TX_HASH_LENGTH } from "./constants"
import { SubmissionFailedError } from "./errors"

export type HttpSubmissionReason =
    "alreadyRegistered" | "rejected" | "unavailable" | "unauthorized" | "network" | "invalidResponse"

export interface HttpSubmissionErrorInit {
    status?: number
    reason: HttpSubmissionReason
    /** The server's own error code, where the response body carried one. */
    serverCode?: string
    /** The registry's current entry, on an `alreadyRegistered` response. */
    metaStealthAddress?: Hex
    matchesRequest?: boolean
    cause?: unknown
}

/**
 * Thrown by {@link createHttpRegistrationSubmitter}. `alreadyRegistered`
 * carries the registry's current `metaStealthAddress` and `matchesRequest`
 * as the answer — a member-side caller has no device secret to re-run
 * `register()` with. A caller that is itself running `register()` (a
 * trusted single process) can instead just re-run it, since its own
 * `registry.getIdentity` read will now return `alreadyRegistered`.
 */
export class HttpSubmissionError extends SubmissionFailedError {
    readonly status?: number
    readonly reason: HttpSubmissionReason
    readonly serverCode?: string
    readonly metaStealthAddress?: Hex
    readonly matchesRequest?: boolean

    constructor(message: string, init: HttpSubmissionErrorInit) {
        super(message, init.cause)
        this.name = "HttpSubmissionError"
        this.status = init.status
        this.reason = init.reason
        this.serverCode = init.serverCode
        this.metaStealthAddress = init.metaStealthAddress
        this.matchesRequest = init.matchesRequest
    }
}

export interface HttpRegistrationSubmitterOptions {
    url: string
    fetch?: typeof fetch
    /** Bearer token for the Network Member Server's member-side routes, sent as
     *  `Authorization: Bearer <memberServerToken>` when set. The server's own token — never a
     *  holder's, so it must not ship in a wallet or app bundle. */
    memberServerToken?: string
}

interface SubmittedBody {
    status: "submitted"
    txHash?: unknown
}

interface AlreadyRegisteredBody {
    status: "alreadyRegistered"
    metaStealthAddress?: Hex
    matchesRequest?: boolean
}

interface ErrorBody {
    code?: string
}

/** Parses `value` as a 32-byte `0x` hex tx hash, or `null` if it isn't one. */
function parseTxHash(value: unknown): Hex | null {
    if (typeof value !== "string") return null
    try {
        return hexToBytes(value as Hex).length === TX_HASH_LENGTH ? (value as Hex) : null
    } catch {
        return null
    }
}

/**
 * HTTP `RegistrationSubmitter` for `apps/issuer-service`'s `POST /v1/registrations`.
 * Never logs or throws the request body or its signature — only the response
 * status and, where sent, the server's own error code.
 */
export function createHttpRegistrationSubmitter({
    url,
    fetch: fetchImpl = fetch,
    memberServerToken
}: HttpRegistrationSubmitterOptions): RegistrationSubmitter {
    return {
        async submit(request: RegistrationRequest): Promise<SubmissionReceipt> {
            let response: Response
            try {
                response = await fetchImpl(`${url}/v1/registrations`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        ...(memberServerToken === undefined ? {} : { Authorization: `Bearer ${memberServerToken}` })
                    },
                    body: JSON.stringify(request)
                })
            } catch (error) {
                throw new HttpSubmissionError("Registration submission failed: network error", {
                    reason: "network",
                    cause: error
                })
            }

            let body: unknown
            try {
                body = await response.json()
            } catch (error) {
                throw new HttpSubmissionError(`Registration submission returned ${response.status} with no JSON body`, {
                    status: response.status,
                    reason: "invalidResponse",
                    cause: error
                })
            }

            if (response.status === 201) {
                const txHash = parseTxHash((body as SubmittedBody | null)?.txHash)
                if (txHash === null) {
                    throw new HttpSubmissionError("Registration submission returned 201 with a malformed body", {
                        status: 201,
                        reason: "invalidResponse"
                    })
                }
                return { txHash }
            }

            if (response.status === 200) {
                const { metaStealthAddress, matchesRequest } = (body ?? {}) as AlreadyRegisteredBody
                throw new HttpSubmissionError("Registration already exists for this networkId", {
                    status: 200,
                    reason: "alreadyRegistered",
                    metaStealthAddress,
                    matchesRequest
                })
            }

            if (response.status === 400) {
                throw new HttpSubmissionError("Registration submission was rejected", {
                    status: 400,
                    reason: "rejected"
                })
            }

            if (response.status === 401) {
                throw new HttpSubmissionError("Registration submission was not authorized", {
                    status: 401,
                    reason: "unauthorized"
                })
            }

            if (response.status === 429 || response.status === 503) {
                throw new HttpSubmissionError("Registration service is unavailable", {
                    status: response.status,
                    reason: "unavailable",
                    serverCode: (body as ErrorBody | null)?.code
                })
            }

            throw new HttpSubmissionError(`Registration submission returned unexpected status ${response.status}`, {
                status: response.status,
                reason: "invalidResponse"
            })
        }
    }
}
