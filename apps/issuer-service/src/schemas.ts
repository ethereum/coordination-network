import { hexToBytes } from "@noble/hashes/utils"
import { Hex32 } from "@coordination-network/credential"
import { z } from "zod"
import { PRESENTATION_REFUSAL_CODES } from "./stores/verification-store"

export const hex32 = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .transform((s) => s.toLowerCase() as Hex32)

// The 0x/0X prefix is optional: every other package in this repo emits 0x-prefixed hex, so a
// member app forwarding these fields from the user app's own output must not be rejected for it.
export const hexBytes = z
    .string()
    .regex(/^(0[xX])?([0-9a-fA-F]{2})+$/)
    .transform((s) => hexToBytes(s.replace(/^0[xX]/, "").toLowerCase()))

export const bigintString = z
    .string()
    .regex(/^\d+$/)
    .transform((s) => BigInt(s))

export const jwkSchema = z.object({ kty: z.literal("EC"), crv: z.literal("P-256"), x: z.string(), y: z.string() })

export const challengeBody = z.object({ subjectNetworkId: hex32 })

export const deliveryBody = z.object({ networkId: hex32 })

export const presentationRequestBody = z.object({
    programme: z.string().min(1),
    country: z.string().regex(/^[A-Z]{3}$/)
})

export const closePresentationRequestBody = z.object({ code: z.enum(PRESENTATION_REFUSAL_CODES) })

export const verifyBody = z.object({
    requestId: z.string().min(1),
    proof: z
        .string()
        .regex(/^0x([0-9a-fA-F]{2})*$/)
        .transform((s) => hexToBytes(s.slice(2).toLowerCase())),
    publicInputs: z.array(z.string())
})

export const registrationBody = z.object({
    version: z.literal("v1"),
    networkId: hex32,
    schemeId: z.literal(1),
    metaStealthAddress: z
        .string()
        .regex(/^0x[0-9a-fA-F]{132}$/)
        .transform((s) => s as `0x${string}`),
    chainId: z.number().int().positive(),
    verifyingContract: z
        .string()
        .regex(/^0x[0-9a-fA-F]{40}$/)
        .transform((s) => s as `0x${string}`),
    signature: z
        .string()
        .regex(/^0x[0-9a-fA-F]{130}$/)
        .transform((s) => s as `0x${string}`)
})

export const credentialsBody = z.object({
    challengeId: z.uuid(),
    subjectNetworkId: hex32,
    approvalScope: z.object({ programme: z.string().min(1), country: z.string().regex(/^[A-Z]{3}$/) }),
    confirmationKey: jwkSchema,
    accountPublicKey: hexBytes,
    devicePopSignature: hexBytes,
    accountPopSignature: hexBytes,
    identityPublicKey: z.tuple([bigintString, bigintString]),
    identityOwnershipSignature: z.object({ R8: z.tuple([bigintString, bigintString]), S: bigintString }),
    revocation: z.object({
        commitment: bigintString,
        publicKey: z.tuple([bigintString, bigintString]),
        ownershipSignature: z.object({ R8: z.tuple([bigintString, bigintString]), S: bigintString })
    }),
    /** Android key attestation chain for the confirmation key: base64 DER, leaf first. */
    deviceAttestation: z.array(z.base64().min(1)).max(10).optional()
})
