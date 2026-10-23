import { z } from "zod"
import { LinkError, type LinkErrorCode } from "@coordination-network/user-app-link"
import type { HttpClient } from "./types"

/**
 * The member-server responses the wallet reads for itself: the two issuance routes it now drives
 * alone, and the verify route it posts a proof to. `@coordination-network/network-member-app-core`
 * keeps its own schemas for the routes the member app still calls; the two packages do not depend on
 * each other, and both are fixed by `apps/issuer-service`.
 */

/**
 * `POST /v1/challenge` writes its nonce with `@noble/hashes`' `bytesToHex`, which never adds the
 * `0x` prefix every other hex field in this protocol carries - accept it either way and normalize
 * to the `0x`-prefixed, lowercase form the binding builders require.
 */
const challengeNonceSchema = z
    .string()
    .regex(/^(0x)?[0-9a-fA-F]{64}$/i, "must be 32-byte hex")
    .transform((value) => `0x${value.replace(/^0x/i, "")}`.toLowerCase() as `0x${string}`)

export const challengeResponseSchema = z
    .object({ challengeId: z.uuid(), nonce: challengeNonceSchema, expiresAt: z.number() })
    .strict()

export const issueCredentialResponseSchema = z.object({ id: z.string().min(1), credential: z.unknown() }).strict()

/**
 * Not `.strict()`: `POST /v1/verify` also answers with its own `ok`/`code`, which the wallet
 * deliberately does not relay — the member app reads the outcome from its own server instead.
 */
export const verifyResponseSchema = z.object({ verificationId: z.string().min(1) })

/** Not `.strict()`: an error body is read for `code`/`error`, whichever route sent it. */
export const errorBodySchema = z.object({ error: z.string().optional(), code: z.string().optional() })

/** A member answering with an error of its own, in its own vocabulary. */
export interface MemberRefusal {
    code?: string
    message: string
}

/**
 * One POST to a member's own server. An answer the route is specified to give is a value; any
 * other answer carrying an error is handed back as the member's own words, for the caller to say
 * what they amount to; anything else means the server is not usefully there, under whichever
 * unreachable code names the side being talked to.
 */
export async function postToMember<T>(
    http: HttpClient,
    url: string,
    body: unknown,
    expected: { status: number; schema: z.ZodType<T>; unreachable: LinkErrorCode }
): Promise<{ value: T; refusal?: never } | { value?: never; refusal: MemberRefusal }> {
    let response
    try {
        response = await http.postJson(url, body)
    } catch (error) {
        throw new LinkError(expected.unreachable, error instanceof Error ? error.message : `POST ${url} failed`)
    }

    const parsed = expected.schema.safeParse(response.body)
    if (response.status === expected.status && parsed.success) return { value: parsed.data }

    const failure = errorBodySchema.safeParse(response.body)
    if (failure.success && failure.data.error !== undefined) {
        return { refusal: { code: failure.data.code, message: failure.data.error } }
    }
    throw new LinkError(expected.unreachable, `${url} returned an unusable response`)
}
