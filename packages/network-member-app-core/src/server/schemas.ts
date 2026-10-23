import { z } from "zod"
import { hex20Schema, hex31Schema, hex32Schema, hex66Schema } from "@coordination-network/user-app-link"

export const revokeResponseSchema = z.object({ id: z.string().min(1), revoked: z.literal(true) }).strict()

export const deliverResponseSchema = z.object({ status: z.literal("announced"), txHash: hex32Schema }).strict()

export const presentationRequestResponseSchema = z
    .object({
        requestId: z.string().min(1),
        challenge: hex31Schema,
        audience: z.string().min(1),
        currentTime: z.number(),
        programme: z.string().min(1),
        country: z.string().min(1),
        expiresAt: z.number()
    })
    .strict()

export const closePresentationRequestResponseSchema = z.object({ verificationId: z.string().min(1) }).strict()

/** `GET /v1/verifications/:id`'s stored record. `code` stays a plain string: the verifier's own
 *  vocabulary grows on its side, and a screen reads it for copy rather than branching on every value. */
export const verificationResponseSchema = z
    .object({
        verificationId: z.string().min(1),
        ok: z.boolean(),
        code: z.string().min(1).optional(),
        issuerLeaf: z.string().min(1).optional(),
        requestId: z.string().min(1),
        audience: z.string().min(1),
        currentTime: z.number(),
        challenge: z.string().min(1),
        programme: z.string().min(1),
        country: z.string().min(1),
        verifiedAt: z.number()
    })
    .strict()

const sponsorshipSchema = z
    .object({
        sender: hex20Schema,
        senderBalanceBefore: z.string(),
        senderBalanceAfter: z.string(),
        userOpHash: hex32Schema,
        bundleTxHash: hex32Schema,
        actualGasCost: z.string(),
        paymaster: hex20Schema,
        paymasterDepositBefore: z.string(),
        paymasterDepositAfter: z.string()
    })
    .strict()

export const registrationSubmittedResponseSchema = z
    .object({ status: z.literal("submitted"), txHash: hex32Schema, sponsorship: sponsorshipSchema.optional() })
    .strict()

export const registrationAlreadyResponseSchema = z
    .object({
        status: z.literal("alreadyRegistered"),
        metaStealthAddress: hex66Schema,
        matchesRequest: z.boolean()
    })
    .strict()

/** Not `.strict()`: an error body is read defensively for `code`/`error`, whichever route sent it. */
export const errorBodySchema = z.object({ error: z.string().optional(), code: z.string().optional() })

export const membershipResponseSchema = z
    .object({
        networkId: hex32Schema,
        authAddress: hex20Schema,
        governanceSigner: hex20Schema,
        metaStealthAddress: hex66Schema,
        status: z.enum(["approved", "requested", "none"]),
        safe: z.object({ address: hex20Schema, threshold: z.number(), owners: z.array(hex20Schema) }).strict(),
        identityRegistered: z.boolean(),
        issuerKeyPublished: z.boolean()
    })
    .strict()

export const presentationStatusSchema = z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }).strict(),
    z.object({ status: z.literal("expired") }).strict(),
    z.object({ status: z.literal("cancelled") }).strict(),
    z.object({ status: z.literal("completed"), verification: verificationResponseSchema }).strict()
])
