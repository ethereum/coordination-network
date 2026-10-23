import { LinkError } from "@coordination-network/user-app-link"
import type { MemberContext } from "../context"
import type { VerifyOutcome, VerifyStage } from "../outcomes"
import { issuersUrl, responseUrl, revocationsUrl } from "../server/urls"
import type { PresentationRefusalCode, PresentationRequestRecord } from "../server/client"
import { failed, runHook } from "./shared"

export interface VerifyInput {
    programme: string
    country: string
    /** Called as each stage is entered, so a screen can move its own steps on a real event -
     *  the wallet answering - instead of a timer. */
    onStage?: (stage: VerifyStage) => void
}

/** The two link errors that mean no proof was ever posted, so the request has to be closed
 *  rather than left to expire with nothing recorded against it. */
function refusalCode(error: unknown): PresentationRefusalCode | null {
    if (!(error instanceof LinkError)) return null
    return error.code === "CREDENTIAL_REVOKED" || error.code === "NO_CREDENTIAL" ? error.code : null
}

/**
 * The member app never sees the proof and never declares what it expects: the user app posts the
 * proof straight to the server's `/v1/verify`, checked against the presentation request the
 * server itself issued below. The verdict is then read back from that server, never from the
 * wallet - a wallet that relayed its own `ok` would be verifying itself.
 */
export async function verify(ctx: MemberContext, input: VerifyInput): Promise<VerifyOutcome> {
    const { onStage } = input
    let request: PresentationRequestRecord
    try {
        onStage?.("presentationRequests")
        request = await ctx.server.createPresentationRequest({ programme: input.programme, country: input.country })
    } catch (error) {
        return failed(ctx.hooks, "verify", "presentationRequests", error)
    }
    const { programme, country } = request

    let verificationId: string
    try {
        onStage?.("presentation.create")
        const result = await ctx.link.request("presentation.create", {
            requestId: request.requestId,
            challenge: request.challenge,
            audience: request.audience,
            currentTime: request.currentTime,
            programme,
            country,
            issuersUrl: issuersUrl(ctx.config.serverUrl),
            // This member's own snapshot of the one network tree: it is the root this server will
            // accept, and serving it says nothing about who issued what the wallet proves.
            revocationsUrl: revocationsUrl(ctx.config.serverUrl),
            responseUrl: responseUrl(ctx.config.serverUrl)
        })
        verificationId = result.verificationId
    } catch (error) {
        const refusal = refusalCode(error)
        if (refusal === null) {
            return failed(ctx.hooks, "verify", "presentation.create", error)
        }

        let closed: { verificationId: string }
        try {
            closed = await ctx.server.closePresentationRequest(request.requestId, refusal)
        } catch (closeError) {
            return failed(ctx.hooks, "verify", "presentationRequests", closeError)
        }

        const refused: Extract<VerifyOutcome, { status: "rejected" }> = {
            status: "rejected",
            code: refusal,
            verificationId: closed.verificationId,
            programme,
            country
        }
        await runHook(ctx.hooks, "verify", "presentationRequests", () => ctx.hooks?.onVerified?.(refused))
        return refused
    }

    try {
        onStage?.("verifications")
        const record = await ctx.server.getVerification(verificationId)
        if (record.requestId !== request.requestId) {
            return failed(
                ctx.hooks,
                "verify",
                "verifications",
                new Error("verification record belongs to another request")
            )
        }

        const outcome: Extract<VerifyOutcome, { status: "verified" | "rejected" }> = record.ok
            ? { status: "verified", verificationId, programme, country }
            : { status: "rejected", code: record.code, verificationId, programme, country }

        await runHook(ctx.hooks, "verify", "verifications", () => ctx.hooks?.onVerified?.(outcome))
        return outcome
    } catch (error) {
        return failed(ctx.hooks, "verify", "verifications", error)
    }
}
