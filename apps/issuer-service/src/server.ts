import express, { NextFunction, Request, Response } from "express"
import { DEFAULT_CREDENTIAL_CIRCUIT_PATH } from "./config"
import { challengeRouter } from "./routes/challenge"
import { credentialsRouter } from "./routes/credentials"
import { deliveriesRouter } from "./routes/deliveries"
import { governanceRouter } from "./routes/governance"
import { healthRouter } from "./routes/health"
import { issuersRouter } from "./routes/issuers"
import { presentationRequestsRouter } from "./routes/presentation-requests"
import { registrationsRouter } from "./routes/registrations"
import { revocationsRouter } from "./routes/revocations"
import { statusRouter } from "./routes/status"
import { verifyRouter } from "./routes/verify"
import { admissionRouter } from "./routes/admission"
import { ActivityLog } from "./activity"
import { GOOGLE_ATTESTATION_ROOTS, createAttestationVerifier } from "./attestation"
import { requireMemberServerToken } from "./auth"
import { rateLimit } from "./rate-limit"
import { createInMemoryIssuerSet } from "./issuer-set"
import { describeError } from "./log"
import { createInMemoryRevocation } from "./revocation"
import { InMemoryIssuanceStore } from "./stores/issuance-store"
import { InMemoryNonceStore } from "./stores/nonce-store"
import { InMemoryPresentationRequestStore } from "./stores/presentation-request-store"
import { InMemoryVerificationStore } from "./stores/verification-store"
import { ServerDeps } from "./types"
import { denyAllIssuancePolicy } from "./issuance-policy"
import type { IssuancePolicy, MutableIssuancePolicy } from "./issuance-policy"
import { validateCredentialValiditySeconds } from "./validity-window"

function isMutableIssuancePolicy(policy: IssuancePolicy): policy is MutableIssuancePolicy {
    return "approve" in policy && typeof policy.approve === "function"
}

export type { ServerDeps } from "./types"

/** body-parser's own signal for malformed JSON, distinguished from an app-thrown error so its body isn't logged. */
function isJsonParseError(err: unknown): boolean {
    if (typeof err !== "object" || err === null) return false
    const { type } = err as { type?: unknown }
    return type === "entity.parse.failed"
}

export function buildServer({
    issuerNetworkId,
    signer,
    resolver,
    approval = resolver,
    identityReader,
    issuancePolicy,
    validitySeconds = 30 * 86400,
    minDeviceSecurityLevel = "TRUSTED_ENVIRONMENT",
    deviceAttestation,
    challengesPerMinute = 30,
    issuancesPerMinute = 30,
    nonceStore,
    issuanceStore,
    registration,
    registrationsPerMinute = 30,
    delivery,
    deliveriesPerMinute = 30,
    revocationsPerMinute = 30,
    governance,
    revocation,
    issuerPublicKeys,
    issuerSet,
    verificationStore,
    verificationRecordTtlSeconds = 86400,
    presentationRequestStore,
    credentialCircuitPath = DEFAULT_CREDENTIAL_CIRCUIT_PATH,
    verifyMaxSkewSeconds = 300,
    verifierAudience = issuerNetworkId,
    presentationRequestTtlSeconds = 300,
    activityLog,
    displayName = issuerNetworkId,
    dashboardUrl,
    peers,
    accent,
    admission,
    memberServerToken,
    allowedOrigins = []
}: ServerDeps) {
    validateCredentialValiditySeconds(validitySeconds)
    if (admission && !memberServerToken) {
        throw new Error("MEMBER_SERVER_TOKEN is required when admission routes are enabled")
    }
    const app = express()

    // Browser callers only. The phone apps send no Origin, so an empty allowlist leaves them alone
    // while a configured one keeps a stray page from driving a member server.
    const origins = new Set(allowedOrigins)
    app.use((req, res, next) => {
        const origin = req.header("origin")
        if (!origin) {
            next()
            return
        }
        if (origins.size > 0 && !origins.has(origin)) {
            res.status(403).json({ error: "origin not allowed" })
            return
        }
        if (!origins.has(origin)) {
            next()
            return
        }
        res.setHeader("Access-Control-Allow-Origin", origin)
        res.setHeader("Vary", "Origin")
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization")
        res.setHeader("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
        if (req.method === "OPTIONS") {
            res.status(204).end()
            return
        }
        next()
    })
    app.use(express.json())

    const nonces = nonceStore ?? new InMemoryNonceStore()
    const records = issuanceStore ?? new InMemoryIssuanceStore()
    const verifications = verificationStore ?? new InMemoryVerificationStore(verificationRecordTtlSeconds)
    const presentationRequests =
        presentationRequestStore ?? new InMemoryPresentationRequestStore(verificationRecordTtlSeconds)
    const revocationBacking = revocation ?? createInMemoryRevocation(resolver)
    const activity = activityLog ?? new ActivityLog()
    const memberSide = requireMemberServerToken(memberServerToken)
    // Directly constructed test/demo servers fail closed unless they explicitly provide both
    // eligibility dependencies. The environment-started executable always supplies them.
    const eligibilityReader = identityReader ?? { getIdentity: async () => null }
    const eligibilityPolicy = issuancePolicy ?? denyAllIssuancePolicy
    // Fails closed: without a fetched status list, issuance answers 503.
    const attestation =
        minDeviceSecurityLevel === "SOFTWARE"
            ? undefined
            : {
                  minimum: minDeviceSecurityLevel,
                  verifier:
                      deviceAttestation ??
                      createAttestationVerifier({
                          roots: GOOGLE_ATTESTATION_ROOTS,
                          statusList: { snapshot: () => ({ unavailable: "never-fetched" }) }
                      })
              }

    // Computed at most once: the signer's own key never changes, and rebuilding the set per request
    // would make every /v1/issuers and /v1/verify call wait on an otherwise-pure tree build.
    let defaultIssuerSet: Promise<ReturnType<typeof createInMemoryIssuerSet>> | undefined
    const resolveDefaultIssuerSet = () => {
        defaultIssuerSet ??= signer
            .getPublicKey()
            .then((own) => createInMemoryIssuerSet([own, ...(issuerPublicKeys ?? [])]))
        return defaultIssuerSet
    }
    const issuerSetBacking = issuerSet ?? {
        read: async () => (await resolveDefaultIssuerSet()).read(),
        isValidRoot: async (root: bigint) => (await resolveDefaultIssuerSet()).isValidRoot(root)
    }

    app.use(healthRouter(attestation?.verifier))
    app.use(challengeRouter(nonces, rateLimit(challengesPerMinute)))
    app.use(
        credentialsRouter({
            issuerNetworkId,
            signer,
            // Not the raw `resolver`: `revocationBacking` is what /v1/revocations/snapshot and
            // /v1/verify read, so a revoke through this router must write the same mirror.
            revocation: revocationBacking,
            approval,
            identityReader: eligibilityReader,
            issuancePolicy: eligibilityPolicy,
            validitySeconds,
            deviceAttestation: attestation,
            nonces,
            records,
            activityLog: activity,
            rateLimit: rateLimit(issuancesPerMinute),
            requireMemberServerToken: memberSide,
            revokeRateLimit: rateLimit(revocationsPerMinute)
        })
    )
    app.use(
        registrationsRouter({
            ports: registration,
            activityLog: activity,
            requireMemberServerToken: memberSide,
            rateLimit: rateLimit(registrationsPerMinute),
            issuancePolicy: isMutableIssuancePolicy(eligibilityPolicy) ? eligibilityPolicy : undefined
        })
    )
    app.use(
        deliveriesRouter({
            issuerNetworkId,
            ports: delivery,
            requireMemberServerToken: memberSide,
            rateLimit: rateLimit(deliveriesPerMinute)
        })
    )
    if (admission) app.use(admissionRouter(admission, memberSide))
    // Not mounted at all when absent, rather than a 503 on each route: the Node scenarios that
    // build a server without governance never see these paths, only Express's own 404. The
    // status page shows this member's own membership, so it is gated on the same condition.
    if (governance) {
        app.use(governanceRouter({ governance, signer, activityLog: activity, requireMemberServerToken: memberSide }))
        app.use(
            statusRouter({
                governance,
                signer,
                issuerSet: issuerSetBacking,
                activityLog: activity,
                displayName,
                dashboardUrl,
                peers,
                accent
            })
        )
    }
    app.use(issuersRouter({ issuerSet: issuerSetBacking }))
    app.use(revocationsRouter(revocationBacking))
    app.use(
        presentationRequestsRouter({
            presentationRequests,
            verifications,
            audience: verifierAudience,
            ttlSeconds: presentationRequestTtlSeconds,
            activityLog: activity,
            requireMemberServerToken: memberSide
        })
    )
    app.use(
        verifyRouter({
            issuerSet: issuerSetBacking,
            revocation: revocationBacking,
            verifications,
            presentationRequests,
            credentialCircuitPath,
            verifyMaxSkewSeconds,
            activityLog: activity,
            requireMemberServerToken: memberSide
        })
    )

    app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) {
            next(err)
            return
        }
        if (isJsonParseError(err)) {
            res.status(400).json({ error: "malformed json" })
            return
        }
        console.error(describeError(err, { stack: true }))
        res.status(500).json({ error: "internal error" })
    })

    return app
}
