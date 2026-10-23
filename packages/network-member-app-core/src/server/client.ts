import type { z } from "zod"
import type { Hex20, Hex31, Hex32, Hex66, SignedRegistrationRequest } from "@coordination-network/user-app-link"
import { MemberServerError } from "./errors"
import type { MemberServerErrorCode } from "./errors"
import {
    closePresentationRequestResponseSchema,
    deliverResponseSchema,
    errorBodySchema,
    membershipResponseSchema,
    presentationRequestResponseSchema,
    registrationAlreadyResponseSchema,
    registrationSubmittedResponseSchema,
    revokeResponseSchema,
    presentationStatusSchema,
    verificationResponseSchema
} from "./schemas"

/** Minimal structural fetch: satisfied by both the browser's and Hermes/React Native's, without a DOM lib. */
export type FetchLike = (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

export interface MemberServerClientOptions {
    baseUrl: string
    fetch: FetchLike
    /** This member's own token, which its revoke, membership, registration, delivery and stored
     *  verification routes ask for. Absent means this install does not hold `baseUrl`'s token,
     *  and those calls will come back `UNAUTHORIZED`; presentation requests and proof submission
     *  stay open either way. */
    memberServerToken?: string
}

/** `Sponsorship`'s bigints as `apps/issuer-service` serializes them: decimal strings, so the wire body survives JSON. */
export interface Sponsorship {
    sender: Hex20
    senderBalanceBefore: string
    senderBalanceAfter: string
    userOpHash: Hex32
    bundleTxHash: Hex32
    actualGasCost: string
    paymaster: Hex20
    paymasterDepositBefore: string
    paymasterDepositAfter: string
}

export type SubmitRegistrationResponse =
    | { status: "submitted"; txHash: Hex32; sponsorship?: Sponsorship }
    | { status: "alreadyRegistered"; metaStealthAddress: Hex66; matchesRequest: boolean }

export interface PresentationRequestRecord {
    requestId: string
    challenge: Hex31
    audience: string
    currentTime: number
    programme: string
    country: string
    expiresAt: number
}

export type MembershipStatusResponse = z.infer<typeof membershipResponseSchema>

/** The verification this member's own server recorded - the only authority on whether a
 *  presentation passed, since the wallet posts the proof to that server directly. */
export type PresentationStatus = z.infer<typeof presentationStatusSchema>

export type VerificationResponse = z.infer<typeof verificationResponseSchema>

/** The two reasons a wallet refuses to present at all, in the vocabulary
 *  `POST /v1/presentation-requests/:id/close` accepts. */
export type PresentationRefusalCode = "CREDENTIAL_REVOKED" | "NO_CREDENTIAL"

export interface MemberServerClient {
    submitRegistration(request: SignedRegistrationRequest): Promise<SubmitRegistrationResponse>
    deliver(input: { networkId: Hex32 }): Promise<{ status: "announced"; txHash: Hex32 }>
    createPresentationRequest(input: { programme: string; country: string }): Promise<PresentationRequestRecord>
    closePresentationRequest(requestId: string, code: PresentationRefusalCode): Promise<{ verificationId: string }>
    getPresentationStatus(requestId: string): Promise<PresentationStatus>
    cancelPresentationRequest(requestId: string): Promise<200 | 409>
    getVerification(verificationId: string): Promise<VerificationResponse>
    revokeCredential(credentialId: string): Promise<{ id: string; revoked: true }>
    getMembership(): Promise<MembershipStatusResponse>
}

interface RawResponse {
    status: number
    body: unknown
}

/** POSTs JSON (or nothing, for `revokeCredential`) and reads back a parsed body. Never throws on a non-2xx status - callers decide what each status means. */
async function send(
    fetchImpl: FetchLike,
    url: string,
    body?: unknown,
    memberServerToken?: string
): Promise<RawResponse> {
    return request(fetchImpl, url, "POST", body, memberServerToken)
}

/** GETs a status/listing route - same parsing and error handling as `send`, no request body. */
async function get(fetchImpl: FetchLike, url: string, memberServerToken?: string): Promise<RawResponse> {
    return request(fetchImpl, url, "GET", undefined, memberServerToken)
}

async function request(
    fetchImpl: FetchLike,
    url: string,
    method: string,
    body?: unknown,
    memberServerToken?: string
): Promise<RawResponse> {
    let status: number
    let text: string
    try {
        const response = await fetchImpl(url, {
            method,
            headers: {
                "Content-Type": "application/json",
                // Only the member-side routes pass a token.
                ...(memberServerToken === undefined ? {} : { Authorization: `Bearer ${memberServerToken}` })
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) })
        })
        status = response.status
        text = await response.text()
    } catch {
        throw new MemberServerError("REQUEST_FAILED", `request to ${url} failed`)
    }

    if (text.length === 0) {
        return { status, body: undefined }
    }
    try {
        return { status, body: JSON.parse(text) }
    } catch {
        throw new MemberServerError("INVALID_RESPONSE", `${url} returned a body that was not valid JSON`, status)
    }
}

/** Reads the server's own `error`/`code` off a non-2xx body, falling back to `fallback` when it sent no code. */
function errorFrom(body: unknown, status: number, fallback: MemberServerErrorCode): MemberServerError {
    const parsed = errorBodySchema.safeParse(body)
    const code = (parsed.success ? (parsed.data.code as MemberServerErrorCode | undefined) : undefined) ?? fallback
    const message = (parsed.success ? parsed.data.error : undefined) ?? `request failed with status ${status}`
    return new MemberServerError(code, message, status)
}

/** 401 is the member server token's own answer; 404 is a credential this member never issued. */
function revokeFallback(status: number): MemberServerErrorCode {
    if (status === 401) return "UNAUTHORIZED"
    return status === 404 ? "NOT_FOUND" : "REQUEST_FAILED"
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown, url: string, status: number): T {
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
        throw new MemberServerError("INVALID_RESPONSE", `${url} returned a response that failed validation`, status)
    }
    return parsed.data
}

export function createMemberServerClient({
    baseUrl,
    fetch: fetchImpl,
    memberServerToken
}: MemberServerClientOptions): MemberServerClient {
    const url = (path: string) => `${baseUrl}${path}`

    return {
        async submitRegistration(request) {
            const path = "/v1/registrations"
            const { status, body } = await send(fetchImpl, url(path), request, memberServerToken)
            if (status === 201) {
                const parsed = parseBody(registrationSubmittedResponseSchema, body, path, status)
                return { status: "submitted", txHash: parsed.txHash, sponsorship: parsed.sponsorship }
            }
            if (status === 200) {
                const parsed = parseBody(registrationAlreadyResponseSchema, body, path, status)
                return {
                    status: "alreadyRegistered",
                    metaStealthAddress: parsed.metaStealthAddress,
                    matchesRequest: parsed.matchesRequest
                }
            }
            const fallback: MemberServerErrorCode =
                status === 400
                    ? "BAD_REQUEST"
                    : status === 401
                      ? "UNAUTHORIZED"
                      : status === 429
                        ? "RATE_LIMITED"
                        : "REQUEST_FAILED"
            throw errorFrom(body, status, fallback)
        },

        async deliver(input) {
            const path = "/v1/deliveries"
            const { status, body } = await send(fetchImpl, url(path), input, memberServerToken)
            if (status === 201) {
                return parseBody(deliverResponseSchema, body, path, status)
            }
            const fallback: MemberServerErrorCode =
                status === 401
                    ? "UNAUTHORIZED"
                    : status === 403
                      ? "MEMBER_NOT_APPROVED"
                      : status === 422
                        ? "DELIVERY_REFUSED"
                        : status === 429
                          ? "RATE_LIMITED"
                          : status === 502
                            ? "ANNOUNCE_FAILED"
                            : status === 503
                              ? "NOT_CONFIGURED"
                              : "REQUEST_FAILED"
            throw errorFrom(body, status, fallback)
        },

        async createPresentationRequest(input) {
            const path = "/v1/presentation-requests"
            const { status, body } = await send(fetchImpl, url(path), input)
            if (status === 201) {
                return parseBody(presentationRequestResponseSchema, body, path, status)
            }
            throw errorFrom(body, status, "BAD_REQUEST")
        },

        async closePresentationRequest(requestId, code) {
            const path = `/v1/presentation-requests/${encodeURIComponent(requestId)}/close`
            const { status, body } = await send(fetchImpl, url(path), { code })
            if (status === 200) {
                return parseBody(closePresentationRequestResponseSchema, body, path, status)
            }
            throw errorFrom(body, status, status === 404 ? "NOT_FOUND" : "REQUEST_FAILED")
        },

        async getPresentationStatus(requestId) {
            const path = `/v1/presentation-requests/${encodeURIComponent(requestId)}`
            const { status, body } = await get(fetchImpl, url(path), memberServerToken)
            if (status === 200) return parseBody(presentationStatusSchema, body, path, status)
            throw errorFrom(
                body,
                status,
                status === 401 ? "UNAUTHORIZED" : status === 404 || status === 410 ? "NOT_FOUND" : "REQUEST_FAILED"
            )
        },

        async cancelPresentationRequest(requestId) {
            const path = `/v1/presentation-requests/${encodeURIComponent(requestId)}/cancel`
            const { status, body } = await send(fetchImpl, url(path), undefined, memberServerToken)
            if (status !== 200 && status !== 409) throw errorFrom(body, status, "REQUEST_FAILED")
            return status
        },

        async getVerification(verificationId) {
            // The id comes back from the wallet over the deep link, so it is not trusted to be path-safe.
            const path = `/v1/verifications/${encodeURIComponent(verificationId)}`
            const { status, body } = await get(fetchImpl, url(path), memberServerToken)
            if (status === 200) {
                return parseBody(verificationResponseSchema, body, path, status)
            }
            throw errorFrom(
                body,
                status,
                status === 401 ? "UNAUTHORIZED" : status === 404 ? "NOT_FOUND" : "REQUEST_FAILED"
            )
        },

        async revokeCredential(credentialId) {
            // The id reaches this app from another app's `credential.issue` result, or from an
            // operator typing it, so it is not trusted to be path-safe.
            const path = `/v1/credentials/${encodeURIComponent(credentialId)}/revoke`
            const { status, body } = await send(fetchImpl, url(path), undefined, memberServerToken)
            if (status === 200) {
                return parseBody(revokeResponseSchema, body, path, status)
            }
            throw errorFrom(body, status, revokeFallback(status))
        },

        async getMembership() {
            const path = "/v1/membership"
            const { status, body } = await get(fetchImpl, url(path), memberServerToken)
            if (status === 200) {
                return parseBody(membershipResponseSchema, body, path, status)
            }
            throw errorFrom(body, status, status === 401 ? "UNAUTHORIZED" : "REQUEST_FAILED")
        }
    }
}
