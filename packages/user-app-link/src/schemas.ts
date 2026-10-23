import { z } from "zod"
import { LINK_ERROR_CODES, type Hex20, type Hex31, type Hex32, type Hex65, type Hex66, type LinkOp } from "./types"

/**
 * A response must stay on-device, in a custom app scheme: `http(s)` would let it leave the device
 * entirely, and Android additionally resolves `intent`/`file`/`content`/`javascript`/`data` to
 * behavior beyond opening another app (launching an arbitrary component, reading a local file, or
 * running script), none of which this protocol's `callback` is meant to reach.
 *
 * The browser schemes map straight onto `http(s)://host/path` - `googlechrome://evil/cb` fetches
 * `http://evil/cb` - so they defeat the rule exactly as `https` would. This list cannot be
 * exhaustive: any installed app may register a scheme that proxies to the network, and nothing in
 * the string says so. Closing it properly needs the signed response envelope and a consent screen
 * showing the resolved callback, both already tracked as follow-ups.
 */
export const DENIED_CALLBACK_SCHEMES = [
    "http",
    "https",
    "intent",
    "file",
    "content",
    "javascript",
    "data",
    "googlechrome",
    "googlechromes",
    "x-safari-http",
    "x-safari-https",
    "microsoft-edge-http",
    "microsoft-edge-https",
    "firefox",
    "ftp",
    "ws",
    "wss"
] as const

/**
 * These fields name server endpoints the app itself fetches or posts to, arriving from an
 * unauthenticated deep-link caller - an allowlist has no unknown-scheme bypass to worry about.
 * TODO: production should require https only; that belongs in configuration, not this schema.
 */
export const ALLOWED_ENDPOINT_URL_SCHEMES = ["http", "https"] as const

/** `encodeResponse` always appends its own `?payload=` to `callback`, so a `?`/`#` already in it would bury or hide that parameter and leave the client waiting until timeout instead of ever decoding a response. */
export const callbackSchema = z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*:\/\/[^\s?#]+$/i, "must be an absolute URL with no query string or fragment")
    .refine(
        (value) =>
            !(DENIED_CALLBACK_SCHEMES as readonly string[]).includes(value.slice(0, value.indexOf(":")).toLowerCase()),
        {
            message: `scheme must not be one of: ${DENIED_CALLBACK_SCHEMES.join(", ")}`
        }
    )

/** No `z.string().url()`: it relies on the global `URL` class, which Hermes/React Native lack without a polyfill. */
const urlLikeSchema = z
    .string()
    .regex(/^[a-z][a-z0-9+.-]*:\/\/\S+$/i, "must be an absolute URL")
    .refine(
        (value) =>
            (ALLOWED_ENDPOINT_URL_SCHEMES as readonly string[]).includes(
                value.slice(0, value.indexOf(":")).toLowerCase()
            ),
        {
            message: `scheme must be one of: ${ALLOWED_ENDPOINT_URL_SCHEMES.join(", ")}`
        }
    )

const hexOfLength = <T extends string>(byteLength: number) =>
    z
        .string()
        .regex(new RegExp(`^0x[0-9a-fA-F]{${byteLength * 2}}$`), `must be ${byteLength}-byte 0x-prefixed hex`)
        .transform((value) => value.toLowerCase() as T)

export const hex20Schema = hexOfLength<Hex20>(20)
export const hex31Schema = hexOfLength<Hex31>(31)
export const hex32Schema = hexOfLength<Hex32>(32)
export const hex65Schema = hexOfLength<Hex65>(65)
export const hex66Schema = hexOfLength<Hex66>(66)

export const securityLevelSchema = z.enum(["STRONGBOX", "TRUSTED_ENVIRONMENT", "SOFTWARE", "UNKNOWN"])

/**
 * `name` and `programme` are both rendered verbatim, on their own line and interpolated into a
 * caption sentence the wallet wrote, so an unbounded or unclean value is a caller reshaping
 * content it doesn't author: past the limit its text crowds the wallet's own closing sentence out
 * of the three-line clip, and a control, formatting, or line/paragraph-separator character can
 * hide text or relayout the line, as a bidi override does.
 */
const sentenceSafeTextSchema = (maxLength: number) =>
    z
        .string()
        .min(1)
        .max(maxLength)
        .regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u, "must not contain control, formatting or line-break characters")

export const callerSchema = z
    .object({
        name: sentenceSafeTextSchema(64),
        scheme: z.string().min(1)
    })
    .strict()

export const approvalScopeSchema = z
    .object({ programme: sentenceSafeTextSchema(64), country: z.string().regex(/^[A-Z]{3}$/, "ISO 3166-1 alpha-3") })
    .strict()

export const registrationSignParamsSchema = z
    .object({ chainId: z.number().int().positive(), verifyingContract: hex20Schema })
    .strict()

export const signedRegistrationRequestSchema = z
    .object({
        version: z.literal("v1"),
        networkId: hex32Schema,
        schemeId: z.literal(1),
        metaStealthAddress: hex66Schema,
        chainId: z.number().int().positive(),
        verifyingContract: hex20Schema,
        signature: hex65Schema
    })
    .strict()

export const registrationSignResultSchema = z
    .object({ request: signedRegistrationRequestSchema, securityLevel: securityLevelSchema })
    .strict()

/** Scheme, host and port, as `urlLikeSchema` guarantees them: everything before the path. No
 *  `new URL` here either, for the same Hermes reason. */
function originOf(url: string): string {
    const pathStart = url.indexOf("/", url.indexOf("://") + 3)
    return (pathStart === -1 ? url : url.slice(0, pathStart)).toLowerCase()
}

/** The four URLs are one server's, so they must say so. The wallet stores `revocationsUrl` for the
 *  credential's life and shows it once, at issuance, as the issuer's server: split origins would
 *  let a caller drive a genuine issuance while pointing every later revocation read at itself. */
const sameOriginEndpoints = ["credentialsUrl", "issuersUrl", "revocationsUrl"] as const

export const credentialIssueParamsSchema = z
    .object({
        issuerNetworkId: hex32Schema,
        approvalScope: approvalScopeSchema,
        challengeUrl: urlLikeSchema,
        credentialsUrl: urlLikeSchema,
        issuersUrl: urlLikeSchema,
        revocationsUrl: urlLikeSchema
    })
    .strict()
    .superRefine((params, ctx) => {
        const origin = originOf(params.challengeUrl)
        for (const field of sameOriginEndpoints) {
            if (originOf(params[field]) !== origin) {
                ctx.addIssue({
                    code: "custom",
                    path: [field],
                    message: `${field} must be on the same origin as challengeUrl (${origin})`
                })
            }
        }
    })

export const credentialIssueResultSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("stored"), credentialId: z.string().min(1) }).strict(),
    z.object({ status: z.literal("alreadyHeld"), credentialId: z.string().min(1) }).strict(),
    z.object({ status: z.literal("refused"), code: z.string().min(1), message: z.string() }).strict()
])

export const presentationCreateParamsSchema = z
    .object({
        requestId: z.string().min(1).max(128),
        challenge: hex31Schema,
        audience: z.string().min(1),
        currentTime: z.number().int().nonnegative(),
        programme: sentenceSafeTextSchema(64),
        country: z.string().regex(/^[A-Z]{3}$/, "ISO 3166-1 alpha-3"),
        issuersUrl: urlLikeSchema,
        revocationsUrl: urlLikeSchema,
        responseUrl: urlLikeSchema
    })
    .strict()
    .superRefine((params, ctx) => {
        // The verifier serves all three, and it is the party that must accept the roots the proof
        // carries. A split origin would let it send the wallet to read somebody else's tree.
        const origin = originOf(params.responseUrl)
        for (const field of ["issuersUrl", "revocationsUrl"] as const) {
            if (originOf(params[field]) !== origin) {
                ctx.addIssue({
                    code: "custom",
                    path: [field],
                    message: `${field} must be on the same origin as responseUrl (${origin})`
                })
            }
        }
    })

export const presentationCreateResultSchema = z.object({ verificationId: z.string().min(1) }).strict()

/** Looked up by the decoded `op` string, so the same schema can be resolved dynamically at runtime. */
export const paramsSchemas: Record<LinkOp, z.ZodTypeAny> = {
    "registration.sign": registrationSignParamsSchema,
    "credential.issue": credentialIssueParamsSchema,
    "presentation.create": presentationCreateParamsSchema
}

export const resultSchemas: Record<LinkOp, z.ZodTypeAny> = {
    "registration.sign": registrationSignResultSchema,
    "credential.issue": credentialIssueResultSchema,
    "presentation.create": presentationCreateResultSchema
}

/** Envelope only: `op`/`params` stay unvalidated because a request that fails those checks still needs a usable `id`/`callback` to answer with an `ok: false` response. */
export const linkRequestEnvelopeSchema = z
    .object({
        id: z.string().min(1),
        version: z.literal("v1"),
        caller: callerSchema,
        callback: callbackSchema,
        op: z.string().min(1),
        params: z.unknown()
    })
    .strict()

const requestEnvelopeFields = {
    id: z.string().min(1),
    version: z.literal("v1"),
    caller: callerSchema,
    callback: callbackSchema
}

/** Written out per op rather than mapped from `LINK_OPS`: `z.discriminatedUnion` needs each branch's literal `op` at the type level, which a `z.ZodTypeAny`-typed loop erases. */
export const linkRequestSchema = z.discriminatedUnion("op", [
    z
        .object({ ...requestEnvelopeFields, op: z.literal("registration.sign"), params: registrationSignParamsSchema })
        .strict(),
    z
        .object({ ...requestEnvelopeFields, op: z.literal("credential.issue"), params: credentialIssueParamsSchema })
        .strict(),
    z
        .object({
            ...requestEnvelopeFields,
            op: z.literal("presentation.create"),
            params: presentationCreateParamsSchema
        })
        .strict()
])

export const linkErrorCodeSchema = z.enum(LINK_ERROR_CODES)

export const linkResponseSchema = z.discriminatedUnion("ok", [
    z.object({ id: z.string().min(1), version: z.literal("v1"), ok: z.literal(true), result: z.unknown() }).strict(),
    z
        .object({
            id: z.string().min(1),
            version: z.literal("v1"),
            ok: z.literal(false),
            code: linkErrorCodeSchema,
            message: z.string().optional()
        })
        .strict()
])
