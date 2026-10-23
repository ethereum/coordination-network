import { z } from "zod"
import { base64UrlDecode, base64UrlEncode, MAX_URL_LENGTH } from "./codec"
import { presentationCreateParamsSchema } from "./schemas"

const PREFIX = "cn-present:v1:"
const publicBase = z
    .string()
    .regex(/^https?:\/\/[^/?#@\s]+(?:\/[^?#@\s]*)?$/, "Server base must not contain credentials, query or fragment")
const schema = z
    .object({
        params: presentationCreateParamsSchema,
        expiresAt: z.number().int().positive()
    })
    .strict()

export type PresentationQr = z.infer<typeof schema>

/** Public challenge only. No credential, proof, callback or member bearer token crosses devices. */
export function encodePresentationQr(value: PresentationQr): string {
    const parsed = schema.parse(value)
    const { params, expiresAt } = parsed
    const base = params.responseUrl.replace(/\/v1\/verify$/, "")
    if (
        base === params.responseUrl ||
        params.issuersUrl !== `${base}/v1/issuers` ||
        params.revocationsUrl !== `${base}/v1/revocations/snapshot`
    )
        throw new Error("Unsupported presentation endpoints")
    publicBase.parse(base)
    // Compact keys and one shared endpoint keep the QR readable at phone-screen sizes.
    const wire = {
        r: params.requestId,
        c: params.challenge,
        a: params.audience,
        t: params.currentTime,
        p: params.programme,
        k: params.country,
        u: base,
        e: expiresAt
    }
    const encoded = PREFIX + base64UrlEncode(new TextEncoder().encode(JSON.stringify(wire)))
    if (encoded.length > MAX_URL_LENGTH) throw new Error("Presentation QR is too large")
    return encoded
}

export function decodePresentationQr(raw: string): PresentationQr {
    if (!raw.startsWith(PREFIX) || raw.length > MAX_URL_LENGTH) throw new Error("Not a presentation QR")
    try {
        const wire = z
            .object({
                r: z.string(),
                c: z.string(),
                a: z.string(),
                t: z.number(),
                p: z.string(),
                k: z.string(),
                u: publicBase,
                e: z.number()
            })
            .strict()
            .parse(JSON.parse(new TextDecoder().decode(base64UrlDecode(raw.slice(PREFIX.length)))))
        return schema.parse({
            expiresAt: wire.e,
            params: {
                requestId: wire.r,
                challenge: wire.c,
                audience: wire.a,
                currentTime: wire.t,
                programme: wire.p,
                country: wire.k,
                issuersUrl: `${wire.u}/v1/issuers`,
                revocationsUrl: `${wire.u}/v1/revocations/snapshot`,
                responseUrl: `${wire.u}/v1/verify`
            }
        })
    } catch {
        throw new Error("Invalid presentation QR")
    }
}
