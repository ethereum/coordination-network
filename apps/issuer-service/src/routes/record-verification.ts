import { randomUUID } from "node:crypto"
import { bytesToHex } from "@noble/hashes/utils"
import { ActivityLog } from "../activity"
import { PresentationRequestRecord, type PresentationRequestStore } from "../stores/presentation-request-store"
import { PresentationRefusalCode, VerificationFailureCode, VerificationStore } from "../stores/verification-store"

/** How a presentation request ended: a proof this verifier accepted, or any reason it did not,
 *  the wallet's own refusal included. */
export type VerificationOutcome = { ok: true } | { ok: false; code: VerificationFailureCode | PresentationRefusalCode }

export interface RecordVerificationDeps {
    presentationRequests: PresentationRequestStore
    verifications: VerificationStore
    activityLog: ActivityLog
}

/**
 * The one place a presentation request's outcome is written down. `/v1/verify` and the close route
 * both answer for the same request and are read back through the same `GET /v1/verifications/:id`,
 * so the record's shape and what the public feed says about it must come from here, not from each
 * route's own copy.
 */
export async function recordVerification(
    { verifications, activityLog, presentationRequests }: RecordVerificationDeps,
    request: PresentationRequestRecord,
    verifiedAt: number,
    outcome: VerificationOutcome
): Promise<string> {
    const verificationId = `urn:uuid:${randomUUID()}`
    await verifications.save({
        verificationId,
        requestId: request.requestId,
        audience: request.audience,
        currentTime: request.currentTime,
        challenge: `0x${bytesToHex(request.challenge)}`,
        programme: request.programme,
        country: request.country,
        verifiedAt,
        ...outcome
    })
    // Replays are recorded for audit but must not overwrite the original attempt's result.
    if (outcome.ok || outcome.code !== "CONSUMED_REQUEST") await presentationRequests.complete(request, verificationId)
    // No ref: verificationId is the only key to GET /v1/verifications/:id, so the public feed
    // must not carry it either.
    activityLog.append(
        "verification",
        outcome.ok ? "verified a presentation" : `verification rejected: ${outcome.code}`,
        undefined,
        outcome.ok ? "ok" : "failed"
    )
    return verificationId
}
