import { Router, type RequestHandler } from "express"
import { bytesToHex } from "@noble/hashes/utils"
import { z } from "zod"
import { ActivityLog } from "../activity"
import { closePresentationRequestBody, presentationRequestBody } from "../schemas"
import { PresentationRequestStore } from "../stores/presentation-request-store"
import { VerificationStore } from "../stores/verification-store"
import { recordVerification } from "./record-verification"

export interface PresentationRequestsRouterDeps {
    presentationRequests: PresentationRequestStore
    verifications: VerificationStore
    /** This server's own identifier, checked as the proof's `audience` public input. */
    audience: string
    ttlSeconds: number
    activityLog: ActivityLog
    requireMemberServerToken?: RequestHandler
}

export function presentationRequestsRouter({
    presentationRequests,
    verifications,
    audience,
    ttlSeconds,
    activityLog,
    requireMemberServerToken = (_req, _res, next) => next()
}: PresentationRequestsRouterDeps): Router {
    const router = Router()

    router.post("/v1/presentation-requests", async (req, res) => {
        const body = presentationRequestBody.safeParse(req.body)
        if (!body.success) {
            res.status(400).json({ error: z.prettifyError(body.error) })
            return
        }

        const record = await presentationRequests.create({
            audience,
            programme: body.data.programme,
            country: body.data.country,
            ttlSeconds
        })
        res.status(201).json({
            requestId: record.requestId,
            challenge: `0x${bytesToHex(record.challenge)}`,
            audience: record.audience,
            currentTime: record.currentTime,
            programme: record.programme,
            country: record.country,
            expiresAt: record.expiresAt
        })
    })

    // These reads belong to the verifier's operator, never to a QR bearer.
    router.get<{ id: string }>("/v1/presentation-requests/:id", requireMemberServerToken, async (req, res) => {
        res.setHeader("cache-control", "no-store")
        const record = await presentationRequests.get(req.params.id)
        if (!record) {
            res.status(404).json({ error: "unknown presentation request" })
            return
        }
        if (record.verificationId) {
            const verification = await verifications.get(record.verificationId)
            if (!verification) {
                res.status(410).json({ error: "verification record expired" })
                return
            }
            res.json({ status: "completed", verification })
        } else if (record.cancelled) {
            res.json({ status: "cancelled" })
        } else if (Math.floor(Date.now() / 1000) > record.expiresAt) {
            res.json({ status: "expired" })
        } else {
            res.json({ status: "pending" })
        }
    })

    router.post<{ id: string }>("/v1/presentation-requests/:id/cancel", requireMemberServerToken, async (req, res) => {
        const cancelled = await presentationRequests.cancel(req.params.id)
        if (cancelled === "unknown") {
            res.status(404).json({ error: "unknown presentation request" })
            return
        }
        if (cancelled === "consumed") {
            res.status(409).json({ error: "request already submitted" })
            return
        }
        res.json({ status: "cancelled" })
    })

    // A wallet that finds no credential worth presenting never posts a proof, so the verifier
    // would otherwise wait out the TTL with nothing to show. Recorded the way `/v1/verify` records
    // a rejection, so a reader of the log or of GET /v1/verifications/:id sees one kind of answer.
    router.post("/v1/presentation-requests/:id/close", async (req, res) => {
        const body = closePresentationRequestBody.safeParse(req.body)
        if (!body.success) {
            res.status(400).json({ error: z.prettifyError(body.error) })
            return
        }

        const closedAt = Math.floor(Date.now() / 1000)
        const claimed = await presentationRequests.consume(req.params.id)
        if (!claimed) {
            res.status(404).json({ error: "unknown presentation request" })
            return
        }
        const { record, alreadyConsumed } = claimed
        // Same two checks `/v1/verify` makes on a claimed request, in the same order, so a request
        // it would refuse outright is refused here too rather than recorded as the wallet's answer.
        const code = alreadyConsumed
            ? "CONSUMED_REQUEST"
            : closedAt > record.expiresAt
              ? "EXPIRED_REQUEST"
              : body.data.code

        const verificationId = await recordVerification(
            { verifications, activityLog, presentationRequests },
            record,
            closedAt,
            {
                ok: false,
                code
            }
        )
        res.json({ verificationId })
    })

    return router
}
