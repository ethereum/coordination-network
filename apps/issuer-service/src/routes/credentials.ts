import { RequestHandler, Router } from "express"
import {
    ApprovalResolver,
    CredentialSigner,
    Hex32,
    IssuanceError,
    jwkToPublicKeyBytes,
    signValidatedZkCredential,
    serializeZkCredential,
    validateZkCredentialIssue
} from "@coordination-network/credential"
import { randomUUID } from "node:crypto"
import { ActivityLog } from "../activity"
import type { AttestationVerifier, AttestedLevel } from "../attestation"
import { RevocationBacking } from "../revocation"
import { credentialsBody } from "../schemas"
import { IssuanceStore } from "../stores/issuance-store"
import { NonceStore } from "../stores/nonce-store"
import { meetsMinimumSecurityLevel } from "../security-level"
import { IssuanceRecord } from "../types"
import type { IdentityReader } from "@coordination-network/network-member-client"
import type { IssuancePolicy } from "../issuance-policy"
import { issuanceValidityWindow } from "../validity-window"

export interface CredentialsRouterDeps {
    issuerNetworkId: Hex32
    signer: CredentialSigner
    revocation: RevocationBacking
    /** Approval reads for the issuance gate; chain-backed in production. */
    approval: ApprovalResolver
    identityReader: IdentityReader
    issuancePolicy: IssuancePolicy
    validitySeconds: number
    /** Absent when the minimum is SOFTWARE: issuance then takes no attestation at all. */
    deviceAttestation?: { minimum: AttestedLevel; verifier: AttestationVerifier }
    nonces: NonceStore
    records: IssuanceStore
    activityLog: ActivityLog
    /** Bounds public proof-validation work, including retries against an unconsumed challenge. */
    rateLimit: RequestHandler
    /** Guards the three member-side routes below. Issuance is left open: a wallet calls it, and
     *  the challenge it has to spend is that route's own check. */
    requireMemberServerToken: RequestHandler
    /** Runs after the token check on the revoke route, which can spend gas or the paymaster deposit. */
    revokeRateLimit: RequestHandler
}

export function credentialsRouter(deps: CredentialsRouterDeps): Router {
    const refusal = { error: "issuance refused", code: "ISSUANCE_REFUSED" }
    const {
        issuerNetworkId,
        signer,
        revocation,
        approval,
        identityReader,
        issuancePolicy,
        validitySeconds,
        deviceAttestation,
        nonces,
        records,
        activityLog,
        rateLimit,
        requireMemberServerToken,
        revokeRateLimit
    } = deps
    const router = Router()

    router.post("/v1/credentials", rateLimit, async (req, res) => {
        const body = credentialsBody.safeParse(req.body)
        if (!body.success) {
            res.status(400).json(refusal)
            return
        }
        const { challengeId, subjectNetworkId } = body.data
        const nonce = await nonces.get(challengeId, subjectNetworkId)
        if (!nonce) {
            res.status(400).json(refusal)
            return
        }

        const now = Math.floor(Date.now() / 1000)
        try {
            const issueParams = {
                issuerNetworkId,
                subjectNetworkId,
                approvalScope: body.data.approvalScope,
                ...issuanceValidityWindow(now, validitySeconds),
                confirmationKey: body.data.confirmationKey,
                accountPublicKey: body.data.accountPublicKey,
                nonce,
                devicePopSignature: body.data.devicePopSignature,
                accountPopSignature: body.data.accountPopSignature,
                identityPublicKey: body.data.identityPublicKey,
                identityOwnershipSignature: body.data.identityOwnershipSignature,
                revocation: body.data.revocation
            }
            // Authenticate the holder before any subject-specific lookup, otherwise the
            // 400/403 distinction becomes an enrolment oracle.
            const credentialBody = await validateZkCredentialIssue(issueParams, approval)

            // Before the enrolment and eligibility lookups, so it is no oracle for either. The
            // challenge stays unconsumed: the holder can retry with a chain that verifies.
            if (deviceAttestation) {
                const refused = checkDeviceAttestation(
                    deviceAttestation,
                    body.data.deviceAttestation ?? [],
                    jwkToPublicKeyBytes(body.data.confirmationKey).subarray(1)
                )
                if (refused) {
                    activityLog.append("credential", `issuance rejected: ${refused.body.code}`, undefined, "failed")
                    res.status(refused.status).json(refused.body)
                    return
                }
            }

            if (!(await identityReader.getIdentity(subjectNetworkId))) {
                activityLog.append("credential", "issuance rejected: SUBJECT_ENROLMENT_PENDING", undefined, "failed")
                res.status(409).json({
                    error: "subject enrolment is not confirmed yet; retry with the same challenge",
                    code: "SUBJECT_ENROLMENT_PENDING"
                })
                return
            }
            const approvedScope = await issuancePolicy.decideIssuance(subjectNetworkId)
            if (
                !approvedScope ||
                approvedScope.programme !== body.data.approvalScope.programme ||
                approvedScope.country !== body.data.approvalScope.country
            ) {
                await nonces.consume(challengeId, subjectNetworkId)
                activityLog.append("credential", "issuance rejected: SUBJECT_NOT_ELIGIBLE", undefined, "failed")
                res.status(403).json({ error: "issuance not permitted", code: "SUBJECT_NOT_ELIGIBLE" })
                return
            }

            if (!(await nonces.consume(challengeId, subjectNetworkId))) {
                activityLog.append("credential", "issuance rejected: CHALLENGE_UNAVAILABLE", undefined, "failed")
                res.status(400).json(refusal)
                return
            }
            const credential = await signValidatedZkCredential(credentialBody, signer)
            const id = `urn:uuid:${randomUUID()}`
            const record: IssuanceRecord = {
                jti: id,
                subjectNetworkId,
                approvalScope: approvedScope,
                nbf: credential.body.notBefore,
                exp: credential.body.expiresAt,
                deviceKeyCommitment: credential.body.deviceKeyCommitment.toString(),
                revocationCommitment: body.data.revocation.commitment.toString()
            }
            await records.save(record)
            // No id or subject in the entry: the listing below publishes ids, but the activity
            // feed still must not link an issuance to its holder via the subject.
            activityLog.append("credential", "issued a credential", undefined, "ok")
            res.status(201).json({ id, credential: serializeZkCredential(credential) })
        } catch (error) {
            if (error instanceof IssuanceError) {
                activityLog.append("credential", `issuance rejected: ${error.code}`, undefined, "failed")
                res.status(400).json(refusal)
                return
            }
            activityLog.append("credential", "issuance failed", undefined, "failed")
            res.status(500).json({ error: "issuance failed" })
        }
    })

    // A credential id is public, at the same trust level as the unauthenticated governance
    // buttons. Nothing reachable by one may name its holder, so neither this listing nor the
    // per-id route below carries the subject or the commitment that identifies the credential
    // itself on the revocation registry.
    router.get("/v1/credentials", requireMemberServerToken, async (_req, res) => {
        const all = await records.list()
        // One root read for the listing, then the mirror: the dashboard polls this per org every
        // two seconds, and a chain read per credential would make one listing cost the whole
        // issuance history. Without the refresh an operator sees a credential as live after
        // another member revoked it, since nothing else tells this process about that write.
        await revocation.refresh()
        res.json({
            credentials: all.map((record) => ({
                id: record.jti,
                programme: record.approvalScope.programme,
                country: record.approvalScope.country,
                issuedAt: record.nbf,
                expiresAt: record.exp,
                revoked: revocation.isRevokedLocally(BigInt(record.revocationCommitment))
            }))
        })
    })

    // Both `:id` routes name their params: with a middleware in the middle, Express infers
    // them as `string | string[]` and `records.get` stops accepting them.
    router.post<{ id: string }>(
        "/v1/credentials/:id/revoke",
        requireMemberServerToken,
        revokeRateLimit,
        async (req, res) => {
            const record = await records.get(req.params.id)
            if (!record) {
                res.status(404).json({ error: "unknown credential" })
                return
            }
            const commitment = BigInt(record.revocationCommitment)
            // Idempotent: a second revoke of the same credential must not throw the underlying
            // registry's own "already revoked" error.
            if (!(await revocation.isRevoked(commitment))) {
                await revocation.revoke(commitment)
            }
            activityLog.append("revocation", "revoked a credential")
            res.json({ id: record.jti, revoked: true })
        }
    )

    router.get<{ id: string }>("/v1/credentials/:id", requireMemberServerToken, async (req, res) => {
        const record = await records.get(req.params.id)
        if (!record) {
            res.status(404).json({ error: "unknown credential" })
            return
        }
        const revoked = await revocation.isRevoked(BigInt(record.revocationCommitment))
        res.json({
            id: record.jti,
            approvalScope: record.approvalScope,
            nbf: record.nbf,
            exp: record.exp,
            revoked
        })
    })

    return router
}

const ATTESTATION_REJECTED = { error: "device key attestation rejected", code: "DEVICE_ATTESTATION_REJECTED" }
const ATTESTATION_UNAVAILABLE = {
    error: "device key attestation cannot be checked right now; retry later",
    code: "DEVICE_ATTESTATION_UNAVAILABLE"
}

/** Answers with fixed text and logs only a reason code: a chain carries the phone's OS, patch
 *  level and boot key, and an RKP serial can link a user across issuances. */
function checkDeviceAttestation(
    { minimum, verifier }: NonNullable<CredentialsRouterDeps["deviceAttestation"]>,
    chain: readonly string[],
    confirmationKeyXY: Uint8Array
): { status: 400 | 503; body: typeof ATTESTATION_REJECTED } | undefined {
    const reject = (reason: string) => {
        console.warn(`device attestation rejected: ${reason}`)
        return { status: 400 as const, body: ATTESTATION_REJECTED }
    }
    if (chain.length === 0) return reject("CHAIN_MISSING")
    const result = verifier.verify(chain, confirmationKeyXY)
    if (!result.ok) {
        if (result.reason === "STATUS_LIST_UNAVAILABLE") return { status: 503, body: ATTESTATION_UNAVAILABLE }
        return reject(result.certIndex === undefined ? result.reason : `${result.reason} at cert ${result.certIndex}`)
    }
    if (!meetsMinimumSecurityLevel(result.level, minimum)) return reject("LEVEL_BELOW_MINIMUM")
    return undefined
}
