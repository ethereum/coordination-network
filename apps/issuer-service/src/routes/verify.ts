import { readFileSync } from "node:fs"
import { RequestHandler, Router } from "express"
import { z } from "zod"
import { ZkCredentialCircuit, ZkCredentialProofSystem } from "@coordination-network/credential"
import { verifyBody } from "../schemas"
import { VerificationFailureCode, VerificationStore } from "../stores/verification-store"
import { PresentationRequestStore } from "../stores/presentation-request-store"
import { ActivityLog } from "../activity"
import { IssuerSetBacking } from "../issuer-set"
import { RevocationBacking } from "../revocation"
import { recordVerification } from "./record-verification"

export interface VerifyRouterDeps {
    issuerSet: IssuerSetBacking
    revocation: RevocationBacking
    verifications: VerificationStore
    presentationRequests: PresentationRequestStore
    credentialCircuitPath: string
    verifyMaxSkewSeconds: number
    activityLog: ActivityLog
    requireMemberServerToken?: RequestHandler
}

export function verifyRouter({
    issuerSet,
    revocation,
    verifications,
    presentationRequests,
    credentialCircuitPath,
    verifyMaxSkewSeconds,
    activityLog,
    requireMemberServerToken = (_req, _res, next) => next()
}: VerifyRouterDeps): Router {
    const router = Router()
    // Built once, on the first request that needs it, then kept for the life of the process: the
    // backend's own startup cost is why `verifyZkPresentationProof`'s create-per-call convenience
    // wrapper isn't used here. A rejection clears the memo instead of being cached, so a bad
    // circuit file doesn't wedge the service until restart once it's fixed.
    let proofSystem: Promise<ZkCredentialProofSystem> | undefined
    const getProofSystem = () => {
        proofSystem ??= ZkCredentialProofSystem.create(
            JSON.parse(readFileSync(credentialCircuitPath, "utf8")) as ZkCredentialCircuit
        ).catch((error) => {
            proofSystem = undefined
            throw error
        })
        return proofSystem
    }

    router.post("/v1/verify", async (req, res, next) => {
        const body = verifyBody.safeParse(req.body)
        if (!body.success) {
            res.status(400).json({ error: z.prettifyError(body.error) })
            return
        }

        try {
            const verifiedAt = Math.floor(Date.now() / 1000)

            // Claims the request before doing any other work, proof verification included: of two
            // concurrent posts for the same requestId, this is what guarantees exactly one sees
            // `alreadyConsumed: false` and only that one can go on to succeed. It also means a
            // thrown error below still leaves the request consumed, not silently reusable.
            const claimed = await presentationRequests.consume(body.data.requestId)
            if (!claimed) {
                res.json({ ok: false, code: "UNKNOWN_REQUEST" })
                return
            }
            const { record, alreadyConsumed } = claimed
            const { audience, currentTime, programme, country } = record

            const respond = async (outcome: { ok: true } | { ok: false; code: VerificationFailureCode }) => {
                const verificationId = await recordVerification(
                    { verifications, activityLog, presentationRequests },
                    record,
                    verifiedAt,
                    outcome
                )
                res.json({ verificationId, ...outcome })
            }

            if (alreadyConsumed) {
                await respond({ ok: false, code: "CONSUMED_REQUEST" })
                return
            }
            if (verifiedAt > record.expiresAt) {
                await respond({ ok: false, code: "EXPIRED_REQUEST" })
                return
            }

            // Only checked against the proof's own public input, otherwise: a proof carrying a past
            // `current_time` verifies as long as the request's own `currentTime` matches it, so
            // this is what actually keeps an old proof from being replayed as if freshly presented.
            if (Math.abs(currentTime - verifiedAt) > verifyMaxSkewSeconds) {
                await respond({ ok: false, code: "STALE_CURRENT_TIME" })
                return
            }

            // Every expected public input comes from the stored request, not the submitter: this
            // is what stops a captured presentation from verifying against a self-declared context.
            const expected = { currentTime, challenge: record.challenge, audience, programme, country }

            const system = await getProofSystem()
            const result = await system.verifyProof(
                { proof: body.data.proof, publicInputs: body.data.publicInputs },
                expected
            )
            if (!result.ok) {
                await respond({ ok: false, code: result.code })
                return
            }

            // A presentation proves membership in the whole approved-issuer set, so its issuer
            // root is that set's root and says nothing about which member signed the credential.
            if (!(await issuerSet.isValidRoot(result.approvedIssuerRoot))) {
                await respond({ ok: false, code: "ISSUER_ROOT_MISMATCH" })
                return
            }

            // One tree holds the whole network's revocations, so there is one root to check and
            // no registry to pick — picking one would name the issuer this proof just hid.
            if (!(await revocation.isValidRoot(result.revocationRoot))) {
                await respond({ ok: false, code: "REVOCATION_ROOT_INVALID" })
                return
            }

            await respond({ ok: true })
        } catch (error) {
            next(error)
        }
    })

    router.get<{ id: string }>("/v1/verifications/:id", requireMemberServerToken, async (req, res) => {
        const record = await verifications.get(req.params.id)
        if (!record) {
            res.status(404).json({ error: "unknown verification" })
            return
        }
        res.json(record)
    })

    return router
}
