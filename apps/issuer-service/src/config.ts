import { hexToBytes } from "@noble/hashes/utils"
import { join, resolve } from "node:path"
import { Hex32 } from "@coordination-network/credential"
import { memberAccountKey } from "@coordination-network/network-member-governance"
import type { SafeVersion } from "@coordination-network/network-member-governance"
import { privateKeyToAccount } from "viem/accounts"
import { z } from "zod"
import { bigintString, hex32 } from "./schemas"
import { MINIMUM_DEVICE_SECURITY_LEVELS, MinimumDeviceSecurityLevel } from "./security-level"
import { credentialArtifactPath } from "@coordination-network/zk-artifacts"

export const DEFAULT_DEVICE_ATTESTATION_STATUS_URL = "https://android.googleapis.com/attestation/status"
export const DEFAULT_CREDENTIAL_CIRCUIT_PATH = credentialArtifactPath("circuit.json")

const REGISTRATION_CORE_KEYS = ["IDENTITY_REGISTRY_ADDRESS", "CHAIN_ID", "MEMBER_IDENTITY_SECRET"] as const

const REGISTRATION_ENV_KEYS = [...REGISTRATION_CORE_KEYS, "SUBMITTER_PRIVATE_KEY"] as const

const SPONSORED_ENV_KEYS = [
    "ENTRY_POINT_ADDRESS",
    "PAYMASTER_ADDRESS",
    "ACCOUNT_IMPLEMENTATION_ADDRESS",
    "BUNDLER_URL"
] as const

const ISSUANCE_ENV_KEYS = ["IDENTITY_REGISTRY_ADDRESS", "CHAIN_ID", "ISSUANCE_PROGRAMME", "ISSUANCE_COUNTRY"] as const

// Each of delivery and revocation is these core keys plus one sender: the sponsored group, or
// MEMBER_PRIVATE_KEY behind its own ALLOW_DIRECT_* flag.
const DELIVERY_ENV_KEYS = ["ANNOUNCER_ADDRESS", "IDENTITY_REGISTRY_ADDRESS", "CHAIN_ID"] as const

const REVOCATION_ENV_KEYS = ["REVOCATION_ADDRESS", "MEMBER_IDENTITY_SECRET"] as const

const GOVERNANCE_ENV_KEYS = [
    "GOVERNANCE_AUTH_PRIVATE_KEY",
    "GOVERNANCE_SIGNER_PRIVATE_KEY",
    "GOVERNANCE_SEMAPHORE_COMMITMENT",
    "GOVERNANCE_META_STEALTH_ADDRESS",
    "NETWORK_MEMBER_REGISTRY_ADDRESS",
    "NETWORK_MEMBER_GROUP_ADDRESS",
    "NETWORK_MEMBER_GOVERNANCE_ADDRESS",
    "GOVERNANCE_SAFE_ADDRESS",
    "APPROVED_ISSUER_SET_ADDRESS",
    "CHAIN_ID"
] as const

/**
 * The env groups share keys — `MEMBER_IDENTITY_SECRET` between registration, revocation and
 * the sponsored group, `CHAIN_ID` between delivery, registration, issuance and governance,
 * `IDENTITY_REGISTRY_ADDRESS` between delivery, registration and issuance — so an unconditional
 * "any key set requires the whole group" check would misfire (e.g. a revocation-only config
 * reading as a partial registration group). Delivery, revocation, governance and the sponsored
 * group are instead triggered only by their own exclusive keys; registration has none left, so
 * its check drops whichever of its keys a complete other group already explains, and the
 * issuance keys alone don't trigger it.
 */
const DELIVERY_TRIGGER_KEYS = ["ANNOUNCER_ADDRESS"] as const
const REVOCATION_TRIGGER_KEYS = ["REVOCATION_ADDRESS"] as const
const GOVERNANCE_TRIGGER_KEYS = [
    "GOVERNANCE_AUTH_PRIVATE_KEY",
    "GOVERNANCE_SIGNER_PRIVATE_KEY",
    "GOVERNANCE_SEMAPHORE_COMMITMENT",
    "GOVERNANCE_META_STEALTH_ADDRESS",
    "NETWORK_MEMBER_REGISTRY_ADDRESS",
    "NETWORK_MEMBER_GROUP_ADDRESS",
    "NETWORK_MEMBER_GOVERNANCE_ADDRESS",
    "GOVERNANCE_SAFE_ADDRESS",
    "APPROVED_ISSUER_SET_ADDRESS"
] as const

const issuerPublicKeyPair = z.tuple([z.string().regex(/^\d+$/), z.string().regex(/^\d+$/)])

const envSchema = z
    .object({
        ISSUER_NETWORK_ID: hex32.default(`0x${"aa".repeat(32)}`),
        ISSUER_PRIVATE_KEY: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
        /** NetworkMemberRegistry contract address; with RPC_URL, switches the issuance approval gate to chain reads. */
        REGISTRY_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        RPC_URL: z.url().optional(),
        /** Server-owned credential scope. Both fields are required by the executable issuance gate. */
        ISSUANCE_PROGRAMME: z.string().min(1).optional(),
        ISSUANCE_COUNTRY: z
            .string()
            .regex(/^[A-Z]{3}$/)
            .optional(),
        PORT: z.coerce.number().int().positive().default(3000),
        /** Requests per 60s window `POST /v1/challenge` accepts before answering 429. */
        CHALLENGES_PER_MINUTE: z.coerce.number().int().positive().default(30),
        /** Requests per 60s window `POST /v1/credentials` accepts before answering 429. */
        ISSUANCES_PER_MINUTE: z.coerce.number().int().positive().default(30),
        /** Lowest attested device key level `POST /v1/credentials` accepts. SOFTWARE skips key attestation. */
        MIN_DEVICE_SECURITY_LEVEL: z.enum(MINIMUM_DEVICE_SECURITY_LEVELS).default("TRUSTED_ENVIRONMENT"),
        /** Google's attestation revocation list, fetched unless MIN_DEVICE_SECURITY_LEVEL is SOFTWARE. */
        DEVICE_ATTESTATION_STATUS_URL: z.url().default(DEFAULT_DEVICE_ATTESTATION_STATUS_URL),
        /** How old the last fetched list may get before issuance answers 503. The list is refetched
         *  at least twice per limit and at most every 15 minutes. */
        DEVICE_ATTESTATION_MAX_STALENESS_SECONDS: z.coerce
            .number()
            .int()
            .min(1800, "DEVICE_ATTESTATION_MAX_STALENESS_SECONDS must be at least 1800 seconds (30 minutes)")
            .default(259200),
        /** Bearer token for the governance group, the credential listing, the revoke route, and
         *  the registration and delivery routes. */
        MEMBER_SERVER_TOKEN: z.string().min(16).optional(),
        /** Retained only so loadConfig can detect and reject the variable this replaced. */
        OPERATOR_TOKEN: z.string().optional(),
        /** Comma-separated browser origins allowed by CORS. Empty by default. */
        CORS_ALLOWED_ORIGINS: z
            .string()
            .default("")
            .transform((value, ctx) => {
                const origins = value
                    .split(",")
                    .map((origin) => origin.trim())
                    .filter(Boolean)
                for (const origin of origins) {
                    try {
                        const url = new URL(origin)
                        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
                            throw new Error()
                        }
                    } catch {
                        ctx.addIssue({
                            code: "custom",
                            message: `CORS_ALLOWED_ORIGINS entry must be an exact http(s) origin: ${origin}`
                        })
                        return z.NEVER
                    }
                }
                return origins
            }),
        /** IdentityRegistry address for the registration endpoint. Required together with CHAIN_ID, MEMBER_IDENTITY_SECRET and one sender. */
        IDENTITY_REGISTRY_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        CHAIN_ID: z.coerce.number().int().positive().optional(),
        /** The network member's own Semaphore identity seed. No default: it must be the seed for the group's admitted commitment. */
        MEMBER_IDENTITY_SECRET: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
        SUBMITTER_PRIVATE_KEY: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
        /** Relays registrations, deliveries and revocations through the paymaster, so no funded key of this member's signs them. */
        ENTRY_POINT_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        PAYMASTER_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        ACCOUNT_IMPLEMENTATION_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        BUNDLER_URL: z.url().optional(),
        /** Block the paymaster's own Semaphore group was created at. */
        PAYMASTER_GROUP_FROM_BLOCK: z.coerce.number().int().nonnegative().default(0),
        /** Opts into SUBMITTER_PRIVATE_KEY, which attributes every enrolled user to its address on chain. */
        ALLOW_DIRECT_REGISTRATION: z.stringbool().default(false),
        /** Requests per 60s window `POST /v1/registrations` accepts before answering 429. */
        REGISTRATIONS_PER_MINUTE: z.coerce.number().int().positive().default(30),
        /** Block the approved-member Semaphore group was created at. Shared by registration and revocation, which prove against the same group. */
        MEMBER_GROUP_FROM_BLOCK: z.coerce.number().int().nonnegative().default(0),
        /** Caps the block span of each `eth_getLogs`, for RPC providers that limit it. Unset reads a range in one call. */
        LOG_WINDOW_BLOCKS: z.coerce.number().int().positive().optional(),
        /** Blocks the governance join-request scan trails the head by, out of reorg reach. Unset follows the head. */
        LOG_CONFIRMATIONS: z.coerce.number().int().nonnegative().optional(),
        /** ERC5564Announcer address for the delivery endpoint. */
        ANNOUNCER_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        /** The network member's own secp256k1 key, sending announce and revoke directly when the sponsored group is unset. Each needs its ALLOW_DIRECT_* flag. */
        MEMBER_PRIVATE_KEY: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
        /** Opts into MEMBER_PRIVATE_KEY for announcements, which attributes every delivery to its address on chain. */
        ALLOW_DIRECT_DELIVERY: z.stringbool().default(false),
        /** Opts into MEMBER_PRIVATE_KEY for revocations, which attributes every revocation to its address on chain. */
        ALLOW_DIRECT_REVOCATION: z.stringbool().default(false),
        /** Requests per 60s window `POST /v1/deliveries` accepts before answering 429. */
        DELIVERIES_PER_MINUTE: z.coerce.number().int().positive().default(30),
        /** Requests per 60s window `POST /v1/credentials/:id/revoke` accepts before answering 429. */
        REVOCATIONS_PER_MINUTE: z.coerce.number().int().positive().default(30),
        /** Deployed `CredentialRevocationRegistry` address — the network's one registry, not the
         *  `Revocation` service behind it, which the registry itself names. Required unless
         *  ALLOW_IN_MEMORY_REVOCATION is set. */
        REVOCATION_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        /** Opts into the in-process revocation mirror for a chain-free demo. Revocations then live
         *  only in this process and are lost on restart. */
        ALLOW_IN_MEMORY_REVOCATION: z.stringbool().default(false),
        /** The member's own hot key for its request-to-join, identity and issuer-key writes. */
        GOVERNANCE_AUTH_PRIVATE_KEY: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
        /** This member's seat at the governance Safe, distinct from the auth key. */
        GOVERNANCE_SIGNER_PRIVATE_KEY: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
        /** This member's own Semaphore identity commitment, announced by requestToJoin. */
        GOVERNANCE_SEMAPHORE_COMMITMENT: bigintString.optional(),
        /** This member's own meta-stealth address, the value `registerNetworkMemberIdentity` records. */
        GOVERNANCE_META_STEALTH_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{132}$/)
            .optional(),
        NETWORK_MEMBER_REGISTRY_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        NETWORK_MEMBER_GROUP_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        NETWORK_MEMBER_GOVERNANCE_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        GOVERNANCE_SAFE_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        APPROVED_ISSUER_SET_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        /** MultiSendCallOnly override, for a chain with no canonical Safe deployment. */
        GOVERNANCE_MULTI_SEND_ADDRESS: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
        /** Block the governance contracts were deployed at, so `getLogs` never scans before it. */
        GOVERNANCE_DEPLOY_BLOCK: z.coerce.number().int().nonnegative().default(0),
        /** Where the governance routes' own `requestToJoin` points approvers to vet this member. */
        GOVERNANCE_METADATA_URI: z.string().default(""),
        GOVERNANCE_SAFE_VERSION: z.string().optional(),
        /** How far a presentation request's `currentTime` may drift from this server's clock before `POST /v1/verify` rejects it as stale. */
        VERIFY_MAX_SKEW_SECONDS: z.coerce.number().int().positive().default(300),
        /** This server's own identifier, checked as a presentation's `audience` public input. Defaults to ISSUER_NETWORK_ID. */
        VERIFIER_AUDIENCE: z.string().min(1).optional(),
        /** How long a `POST /v1/presentation-requests` result stays valid before `POST /v1/verify` rejects it as expired. */
        PRESENTATION_REQUEST_TTL_SECONDS: z.coerce.number().int().positive().default(300),
        /** How long a verification outcome remains readable before it is purged. */
        VERIFICATION_RECORD_TTL_SECONDS: z.coerce.number().int().positive().default(86400),
        /** Extra approved issuer keys this member's presentations should serve, beyond its own. */
        APPROVED_ISSUER_PUBLIC_KEYS: z
            .string()
            .optional()
            .transform((value, ctx) => {
                if (value === undefined) return undefined
                let parsed: unknown
                try {
                    parsed = JSON.parse(value)
                } catch {
                    ctx.addIssue({ code: "custom", message: "APPROVED_ISSUER_PUBLIC_KEYS must be valid JSON" })
                    return z.NEVER
                }
                const pairs = z.array(issuerPublicKeyPair).safeParse(parsed)
                if (!pairs.success) {
                    ctx.addIssue({
                        code: "custom",
                        message: "APPROVED_ISSUER_PUBLIC_KEYS must be a JSON array of [x, y] decimal-string pairs"
                    })
                    return z.NEVER
                }
                return pairs.data
            }),
        /** Compiled credential-circuit JSON, resolved against the app directory. Defaults to the repository's own. */
        CREDENTIAL_CIRCUIT_PATH: z.string().optional()
    })
    .superRefine((env, ctx) => {
        if (env.OPERATOR_TOKEN !== undefined) {
            ctx.addIssue({ code: "custom", message: "OPERATOR_TOKEN was renamed to MEMBER_SERVER_TOKEN" })
        }

        // A complete instance of another group explains every key registration shares with it;
        // the remainder is registration's own, and that is what the check applies to. The message
        // still names the whole group, minus the sender when sponsored, since that is what a partial
        // set is missing.
        const explained = new Set<string>()
        if (SPONSORED_ENV_KEYS.every((key) => env[key] !== undefined)) explained.add("MEMBER_IDENTITY_SECRET")
        if (DELIVERY_ENV_KEYS.every((key) => env[key] !== undefined)) DELIVERY_ENV_KEYS.forEach((k) => explained.add(k))
        if (GOVERNANCE_TRIGGER_KEYS.every((key) => env[key] !== undefined)) {
            GOVERNANCE_ENV_KEYS.forEach((k) => explained.add(k))
        }
        if (REVOCATION_ENV_KEYS.every((key) => env[key] !== undefined)) {
            REVOCATION_ENV_KEYS.forEach((k) => explained.add(k))
        }
        const sponsored = SPONSORED_ENV_KEYS.some((key) => env[key] !== undefined)
        const direct = env.SUBMITTER_PRIVATE_KEY !== undefined

        // Under the sponsored group the sender is the paymaster, so SUBMITTER_PRIVATE_KEY is not
        // part of what registration still needs.
        const registrationGroup = sponsored ? REGISTRATION_CORE_KEYS : REGISTRATION_ENV_KEYS
        const registrationKeys = registrationGroup.filter((key) => !explained.has(key))
        const set = registrationKeys.filter((key) => env[key] !== undefined)
        const issuanceTriggered = env.ISSUANCE_PROGRAMME !== undefined || env.ISSUANCE_COUNTRY !== undefined
        if (issuanceTriggered && env.ISSUER_PRIVATE_KEY === undefined) {
            ctx.addIssue({ code: "custom", message: "ISSUER_PRIVATE_KEY is required for credential issuance" })
        }
        const registrationTriggered =
            direct ||
            (!explained.has("MEMBER_IDENTITY_SECRET") && env.MEMBER_IDENTITY_SECRET !== undefined) ||
            (!issuanceTriggered && set.length !== 0)
        const coreWithoutSender = !sponsored && !direct && REGISTRATION_CORE_KEYS.every((key) => env[key] !== undefined)
        if (registrationTriggered && coreWithoutSender) {
            ctx.addIssue({
                code: "custom",
                message: `${REGISTRATION_CORE_KEYS.join(", ")} need a sender: set ${SPONSORED_ENV_KEYS.join(", ")} to relay through the paymaster, or SUBMITTER_PRIVATE_KEY with ALLOW_DIRECT_REGISTRATION=true`
            })
        } else if (registrationTriggered && set.length !== registrationKeys.length) {
            ctx.addIssue({ code: "custom", message: `${registrationGroup.join(", ")} must all be set together` })
        }
        if (registrationTriggered && env.RPC_URL === undefined) {
            ctx.addIssue({ code: "custom", message: `${registrationGroup.join(", ")} require RPC_URL` })
        }
        if (direct && !sponsored && !env.ALLOW_DIRECT_REGISTRATION) {
            ctx.addIssue({
                code: "custom",
                message: `SUBMITTER_PRIVATE_KEY writes every registration from one funded address, attributing each user this member enrols to it on chain: set ${SPONSORED_ENV_KEYS.join(", ")} to relay through the paymaster instead, or ALLOW_DIRECT_REGISTRATION=true to accept that`
            })
        }

        const issuanceSet = ISSUANCE_ENV_KEYS.filter((key) => env[key] !== undefined)
        if (issuanceTriggered && issuanceSet.length !== ISSUANCE_ENV_KEYS.length) {
            ctx.addIssue({ code: "custom", message: `${ISSUANCE_ENV_KEYS.join(", ")} must all be set together` })
        }
        if (issuanceTriggered && env.RPC_URL === undefined) {
            ctx.addIssue({ code: "custom", message: `${ISSUANCE_ENV_KEYS.join(", ")} require RPC_URL` })
        }

        const memberKeyed = env.MEMBER_PRIVATE_KEY !== undefined
        const deliveryTriggered = DELIVERY_TRIGGER_KEYS.some((key) => env[key] !== undefined)
        const revocationTriggered = REVOCATION_TRIGGER_KEYS.some((key) => env[key] !== undefined)
        if (sponsored) {
            const routeComplete = [REGISTRATION_CORE_KEYS, DELIVERY_ENV_KEYS, REVOCATION_ENV_KEYS].some((keys) =>
                keys.every((key) => env[key] !== undefined)
            )
            if (!routeComplete || env.MEMBER_IDENTITY_SECRET === undefined) {
                ctx.addIssue({
                    code: "custom",
                    message: `${SPONSORED_ENV_KEYS.join(", ")} relay registrations, deliveries and revocations and need MEMBER_IDENTITY_SECRET and one route's keys: registration ${REGISTRATION_CORE_KEYS.join(", ")}; delivery ${DELIVERY_ENV_KEYS.join(", ")}; revocation ${REVOCATION_ENV_KEYS.join(", ")}`
                })
            }
            if (direct) {
                ctx.addIssue({
                    code: "custom",
                    message: "SUBMITTER_PRIVATE_KEY and the sponsored group are two senders for one route; unset one"
                })
            }
        }
        if (sponsored && memberKeyed && (deliveryTriggered || revocationTriggered)) {
            ctx.addIssue({
                code: "custom",
                message:
                    "MEMBER_PRIVATE_KEY and the sponsored group are two senders for delivery and revocation; unset one"
            })
        }
        for (const [noun, keys, triggered, flag, allowed] of [
            ["announcement", DELIVERY_ENV_KEYS, deliveryTriggered, "ALLOW_DIRECT_DELIVERY", env.ALLOW_DIRECT_DELIVERY],
            [
                "revocation",
                REVOCATION_ENV_KEYS,
                revocationTriggered,
                "ALLOW_DIRECT_REVOCATION",
                env.ALLOW_DIRECT_REVOCATION
            ]
        ] as const) {
            if (!triggered || sponsored || !keys.every((key) => env[key] !== undefined)) continue
            if (!memberKeyed) {
                ctx.addIssue({
                    code: "custom",
                    message: `${keys.join(", ")} need a sender: set ${SPONSORED_ENV_KEYS.join(", ")} to relay through the paymaster, or MEMBER_PRIVATE_KEY with ${flag}=true`
                })
            } else if (!allowed) {
                ctx.addIssue({
                    code: "custom",
                    message: `MEMBER_PRIVATE_KEY sends every ${noun} from one funded address, attributing each one this member makes to it on chain: set ${SPONSORED_ENV_KEYS.join(", ")} to relay through the paymaster instead, or ${flag}=true to accept that`
                })
            }
        }

        for (const [keys, triggerKeys] of [
            [DELIVERY_ENV_KEYS, DELIVERY_TRIGGER_KEYS],
            [REVOCATION_ENV_KEYS, REVOCATION_TRIGGER_KEYS],
            [GOVERNANCE_ENV_KEYS, GOVERNANCE_TRIGGER_KEYS],
            [SPONSORED_ENV_KEYS, SPONSORED_ENV_KEYS]
        ] as const) {
            if (!triggerKeys.some((key) => env[key] !== undefined)) continue
            if (!keys.every((key) => env[key] !== undefined)) {
                ctx.addIssue({ code: "custom", message: `${keys.join(", ")} must all be set together` })
            } else if (env.RPC_URL === undefined) {
                ctx.addIssue({ code: "custom", message: `${keys.join(", ")} require RPC_URL` })
            }
        }

        // A server started from the environment fails closed. `buildServer` still accepts no
        // token, which is what the Node scenarios and the route tests mount, but a member-side
        // API reachable over a network has to be asked for deliberately.
        if (env.MEMBER_SERVER_TOKEN === undefined) {
            ctx.addIssue({
                code: "custom",
                message:
                    "MEMBER_SERVER_TOKEN is required: environment-started servers expose member-side credential, verification and optional governance routes"
            })
        }

        // Fails closed the same way as the MEMBER_SERVER_TOKEN check above.
        if (!revocationTriggered && !env.ALLOW_IN_MEMORY_REVOCATION) {
            ctx.addIssue({
                code: "custom",
                message: `${REVOCATION_ENV_KEYS.join(", ")} and a sender (${SPONSORED_ENV_KEYS.join(", ")}, or MEMBER_PRIVATE_KEY with ALLOW_DIRECT_REVOCATION=true) are required unless ALLOW_IN_MEMORY_REVOCATION=true: an in-process mirror loses every revocation on restart and never sees another member's`
            })
        }
    })

/** What `buildGovernancePorts` needs: this member's own keys and identity, and where the
 *  governance contracts live. `networkId` doubles as `ISSUER_NETWORK_ID`: the governance routes
 *  and the credential-issuing routes are the same member. */
export interface GovernanceConfig {
    authPrivateKey: `0x${string}`
    governanceSignerPrivateKey: `0x${string}`
    networkId: Hex32
    semaphoreCommitment: bigint
    metaStealthAddress: `0x${string}`
    registry: `0x${string}`
    group: `0x${string}`
    governance: `0x${string}`
    safe: `0x${string}`
    issuerSet: `0x${string}`
    multiSend?: `0x${string}`
    deployBlock: number
    /** Caps the block span of each `eth_getLogs` the join-request scan issues. */
    logWindowBlocks?: number
    /** Holds the join-request scan this many blocks behind the head, out of reorg reach. */
    logConfirmations?: number
    metadataURI: string
    safeVersion?: SafeVersion
    chainId: number
}

/**
 * What a sponsored transport needs beyond the direct one: a seed for the disposable senders it
 * relays through, and where the account-abstraction stack lives. Registration, delivery and revocation
 * read it from env; a local stack that deploys its own EntryPoint and paymaster builds it in code.
 */
export interface SponsoredConfig {
    /** Seeds `deriveKeys` for the disposable sender. Kept apart from `memberIdentitySecret`, but `loadConfig` and the testbed both set it to that same secret. */
    memberSecret: `0x${string}`
    entryPoint: `0x${string}`
    paymaster: `0x${string}`
    accountImplementation: `0x${string}`
    bundlerUrl: string
    /** Block the paymaster's own Semaphore group was created at. */
    paymasterGroupFromBlock: number
    /** Caps the block span of each `eth_getLogs` the paymaster group mirror issues. */
    logWindowBlocks?: number
}

type MemberSender =
    { memberPrivateKey: `0x${string}`; sponsored?: never } | { sponsored: SponsoredConfig; memberPrivateKey?: never }

export interface Config {
    issuerNetworkId: Hex32
    issuerPrivateKey?: Uint8Array
    registryAddress?: `0x${string}`
    rpcUrl?: string
    issuance?: {
        identityRegistryAddress: `0x${string}`
        chainId: number
        approvalScope: { programme: string; country: string }
    }
    port: number
    challengesPerMinute: number
    issuancesPerMinute: number
    minDeviceSecurityLevel: MinimumDeviceSecurityLevel
    deviceAttestationStatusUrl: string
    deviceAttestationMaxStalenessSeconds: number
    registration?: {
        identityRegistryAddress: `0x${string}`
        chainId: number
        memberIdentitySecret: Uint8Array
        /** Absent when `sponsored` is set: a relayed write is signed by a disposable sender, not this key. */
        submitterPrivateKey?: `0x${string}`
        memberGroupFromBlock: number
        /** Caps the block span of each `eth_getLogs` the member-group mirror issues. */
        logWindowBlocks?: number
        sponsored?: SponsoredConfig
    }
    registrationsPerMinute: number
    delivery?: {
        identityRegistryAddress: `0x${string}`
        chainId: number
        announcerAddress: `0x${string}`
    } & (
        | { memberPrivateKey: `0x${string}`; sponsored?: never; memberIdentitySecret?: never }
        | { sponsored: SponsoredConfig; memberIdentitySecret: Uint8Array; memberPrivateKey?: never }
    )
    deliveriesPerMinute: number
    revocationsPerMinute: number
    revocation?: {
        /** The `CredentialRevocationRegistry`; the revocation service and registry id are read off it. */
        address: `0x${string}`
        memberIdentitySecret: Uint8Array
        memberGroupFromBlock: number
        /** Caps the block span of each `eth_getLogs` the member-group mirror issues. */
        logWindowBlocks?: number
    } & MemberSender
    governance?: GovernanceConfig
    issuerPublicKeys?: [bigint, bigint][]
    credentialCircuitPath: string
    verifyMaxSkewSeconds: number
    verifierAudience: string
    presentationRequestTtlSeconds: number
    verificationRecordTtlSeconds: number
    allowedOrigins: string[]
    memberServerToken?: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const parsed = envSchema.parse(env)

    let sponsored: SponsoredConfig | undefined
    if (
        parsed.MEMBER_IDENTITY_SECRET !== undefined &&
        parsed.ENTRY_POINT_ADDRESS !== undefined &&
        parsed.PAYMASTER_ADDRESS !== undefined &&
        parsed.ACCOUNT_IMPLEMENTATION_ADDRESS !== undefined &&
        parsed.BUNDLER_URL !== undefined
    ) {
        sponsored = {
            memberSecret: `0x${parsed.MEMBER_IDENTITY_SECRET}`,
            entryPoint: parsed.ENTRY_POINT_ADDRESS as `0x${string}`,
            paymaster: parsed.PAYMASTER_ADDRESS as `0x${string}`,
            accountImplementation: parsed.ACCOUNT_IMPLEMENTATION_ADDRESS as `0x${string}`,
            bundlerUrl: parsed.BUNDLER_URL,
            paymasterGroupFromBlock: parsed.PAYMASTER_GROUP_FROM_BLOCK,
            logWindowBlocks: parsed.LOG_WINDOW_BLOCKS
        }
    }

    let registration: Config["registration"]
    if (
        parsed.IDENTITY_REGISTRY_ADDRESS !== undefined &&
        parsed.CHAIN_ID !== undefined &&
        parsed.MEMBER_IDENTITY_SECRET !== undefined &&
        (parsed.SUBMITTER_PRIVATE_KEY !== undefined || sponsored !== undefined)
    ) {
        registration = {
            identityRegistryAddress: parsed.IDENTITY_REGISTRY_ADDRESS as `0x${string}`,
            chainId: parsed.CHAIN_ID,
            memberIdentitySecret: hexToBytes(parsed.MEMBER_IDENTITY_SECRET.toLowerCase()),
            submitterPrivateKey:
                parsed.SUBMITTER_PRIVATE_KEY === undefined ? undefined : `0x${parsed.SUBMITTER_PRIVATE_KEY}`,
            memberGroupFromBlock: parsed.MEMBER_GROUP_FROM_BLOCK,
            logWindowBlocks: parsed.LOG_WINDOW_BLOCKS,
            sponsored
        }
    }

    let delivery: Config["delivery"]
    if (
        parsed.ANNOUNCER_ADDRESS !== undefined &&
        parsed.IDENTITY_REGISTRY_ADDRESS !== undefined &&
        parsed.CHAIN_ID !== undefined
    ) {
        const core = {
            identityRegistryAddress: parsed.IDENTITY_REGISTRY_ADDRESS as `0x${string}`,
            chainId: parsed.CHAIN_ID,
            announcerAddress: parsed.ANNOUNCER_ADDRESS as `0x${string}`
        }
        if (sponsored !== undefined && parsed.MEMBER_IDENTITY_SECRET !== undefined) {
            delivery = {
                ...core,
                sponsored,
                memberIdentitySecret: hexToBytes(parsed.MEMBER_IDENTITY_SECRET.toLowerCase())
            }
        } else if (parsed.MEMBER_PRIVATE_KEY !== undefined) {
            delivery = { ...core, memberPrivateKey: `0x${parsed.MEMBER_PRIVATE_KEY}` }
        }
    }

    let revocation: Config["revocation"]
    if (parsed.REVOCATION_ADDRESS !== undefined && parsed.MEMBER_IDENTITY_SECRET !== undefined) {
        const core = {
            address: parsed.REVOCATION_ADDRESS as `0x${string}`,
            memberIdentitySecret: hexToBytes(parsed.MEMBER_IDENTITY_SECRET.toLowerCase()),
            memberGroupFromBlock: parsed.MEMBER_GROUP_FROM_BLOCK,
            logWindowBlocks: parsed.LOG_WINDOW_BLOCKS
        }
        if (sponsored !== undefined) {
            revocation = { ...core, sponsored }
        } else if (parsed.MEMBER_PRIVATE_KEY !== undefined) {
            revocation = { ...core, memberPrivateKey: `0x${parsed.MEMBER_PRIVATE_KEY}` }
        }
    }

    let governance: Config["governance"]
    if (
        parsed.GOVERNANCE_AUTH_PRIVATE_KEY !== undefined &&
        parsed.GOVERNANCE_SIGNER_PRIVATE_KEY !== undefined &&
        parsed.GOVERNANCE_SEMAPHORE_COMMITMENT !== undefined &&
        parsed.GOVERNANCE_META_STEALTH_ADDRESS !== undefined &&
        parsed.NETWORK_MEMBER_REGISTRY_ADDRESS !== undefined &&
        parsed.NETWORK_MEMBER_GROUP_ADDRESS !== undefined &&
        parsed.NETWORK_MEMBER_GOVERNANCE_ADDRESS !== undefined &&
        parsed.GOVERNANCE_SAFE_ADDRESS !== undefined &&
        parsed.APPROVED_ISSUER_SET_ADDRESS !== undefined &&
        parsed.CHAIN_ID !== undefined
    ) {
        const authPrivateKey = `0x${parsed.GOVERNANCE_AUTH_PRIVATE_KEY}` as const
        const { memberNetworkId } = memberAccountKey(privateKeyToAccount(authPrivateKey).publicKey)
        if (parsed.ISSUER_NETWORK_ID !== memberNetworkId) {
            throw new Error(
                `ISSUER_NETWORK_ID must be ${memberNetworkId}, the id the registry derives from GOVERNANCE_AUTH_PRIVATE_KEY`
            )
        }

        governance = {
            authPrivateKey,
            governanceSignerPrivateKey: `0x${parsed.GOVERNANCE_SIGNER_PRIVATE_KEY}`,
            networkId: parsed.ISSUER_NETWORK_ID,
            semaphoreCommitment: parsed.GOVERNANCE_SEMAPHORE_COMMITMENT,
            metaStealthAddress: parsed.GOVERNANCE_META_STEALTH_ADDRESS as `0x${string}`,
            registry: parsed.NETWORK_MEMBER_REGISTRY_ADDRESS as `0x${string}`,
            group: parsed.NETWORK_MEMBER_GROUP_ADDRESS as `0x${string}`,
            governance: parsed.NETWORK_MEMBER_GOVERNANCE_ADDRESS as `0x${string}`,
            safe: parsed.GOVERNANCE_SAFE_ADDRESS as `0x${string}`,
            issuerSet: parsed.APPROVED_ISSUER_SET_ADDRESS as `0x${string}`,
            multiSend: parsed.GOVERNANCE_MULTI_SEND_ADDRESS as `0x${string}` | undefined,
            deployBlock: parsed.GOVERNANCE_DEPLOY_BLOCK,
            logWindowBlocks: parsed.LOG_WINDOW_BLOCKS,
            logConfirmations: parsed.LOG_CONFIRMATIONS,
            metadataURI: parsed.GOVERNANCE_METADATA_URI,
            safeVersion: parsed.GOVERNANCE_SAFE_VERSION as SafeVersion | undefined,
            chainId: parsed.CHAIN_ID
        }
    }

    const issuance =
        parsed.IDENTITY_REGISTRY_ADDRESS !== undefined &&
        parsed.CHAIN_ID !== undefined &&
        parsed.ISSUANCE_PROGRAMME !== undefined &&
        parsed.ISSUANCE_COUNTRY !== undefined
            ? {
                  identityRegistryAddress: parsed.IDENTITY_REGISTRY_ADDRESS as `0x${string}`,
                  chainId: parsed.CHAIN_ID,
                  approvalScope: { programme: parsed.ISSUANCE_PROGRAMME, country: parsed.ISSUANCE_COUNTRY }
              }
            : undefined

    return {
        issuerNetworkId: parsed.ISSUER_NETWORK_ID,
        issuerPrivateKey: parsed.ISSUER_PRIVATE_KEY ? hexToBytes(parsed.ISSUER_PRIVATE_KEY.toLowerCase()) : undefined,
        registryAddress: parsed.REGISTRY_ADDRESS as `0x${string}` | undefined,
        rpcUrl: parsed.RPC_URL,
        issuance,
        port: parsed.PORT,
        challengesPerMinute: parsed.CHALLENGES_PER_MINUTE,
        issuancesPerMinute: parsed.ISSUANCES_PER_MINUTE,
        minDeviceSecurityLevel: parsed.MIN_DEVICE_SECURITY_LEVEL,
        deviceAttestationStatusUrl: parsed.DEVICE_ATTESTATION_STATUS_URL,
        deviceAttestationMaxStalenessSeconds: parsed.DEVICE_ATTESTATION_MAX_STALENESS_SECONDS,
        registration,
        registrationsPerMinute: parsed.REGISTRATIONS_PER_MINUTE,
        delivery,
        deliveriesPerMinute: parsed.DELIVERIES_PER_MINUTE,
        revocationsPerMinute: parsed.REVOCATIONS_PER_MINUTE,
        revocation,
        governance,
        issuerPublicKeys: parsed.APPROVED_ISSUER_PUBLIC_KEYS?.map(([x, y]) => [BigInt(x), BigInt(y)]),
        credentialCircuitPath: parsed.CREDENTIAL_CIRCUIT_PATH
            ? resolve(join(__dirname, ".."), parsed.CREDENTIAL_CIRCUIT_PATH)
            : DEFAULT_CREDENTIAL_CIRCUIT_PATH,
        verifyMaxSkewSeconds: parsed.VERIFY_MAX_SKEW_SECONDS,
        verifierAudience: parsed.VERIFIER_AUDIENCE ?? parsed.ISSUER_NETWORK_ID,
        presentationRequestTtlSeconds: parsed.PRESENTATION_REQUEST_TTL_SECONDS,
        verificationRecordTtlSeconds: parsed.VERIFICATION_RECORD_TTL_SECONDS,
        allowedOrigins: parsed.CORS_ALLOWED_ORIGINS,
        memberServerToken: parsed.MEMBER_SERVER_TOKEN
    }
}
