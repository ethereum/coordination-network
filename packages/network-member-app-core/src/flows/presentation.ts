import { encodePresentationQr } from "@coordination-network/user-app-link"
import type { MemberContext } from "../context"
import type { PresentationStatus } from "../server/client"
import { issuersUrl, responseUrl, revocationsUrl } from "../server/urls"
import { failed, runHook } from "./shared"
import type { VerifyOutcome } from "../outcomes"

export interface PresentationChallenge {
    requestId: string
    expiresAt: number
    qr: string
}

/** Cross-device handoff: only public challenge data reaches the holder's phone. */
export async function startPresentation(
    ctx: MemberContext,
    input: { programme: string; country: string }
): Promise<PresentationChallenge> {
    let request
    try {
        request = await ctx.server.createPresentationRequest(input)
    } catch (error) {
        await failed(ctx.hooks, "verify", "presentationRequests", error)
        throw error
    }
    return {
        requestId: request.requestId,
        expiresAt: request.expiresAt,
        qr: encodePresentationQr({
            expiresAt: request.expiresAt,
            params: {
                requestId: request.requestId,
                challenge: request.challenge,
                audience: request.audience,
                currentTime: request.currentTime,
                programme: request.programme,
                country: request.country,
                issuersUrl: issuersUrl(ctx.config.serverUrl),
                revocationsUrl: revocationsUrl(ctx.config.serverUrl),
                responseUrl: responseUrl(ctx.config.serverUrl)
            }
        })
    }
}

export async function presentationStatus(
    ctx: MemberContext,
    requestId: string,
    reported: Set<string>
): Promise<PresentationStatus> {
    try {
        const status = await ctx.server.getPresentationStatus(requestId)
        if (status.status === "completed") {
            const record = status.verification
            if (record.requestId !== requestId) throw new Error("verification record belongs to another request")
            if (!reported.has(requestId)) {
                reported.add(requestId)
                const outcome: Extract<VerifyOutcome, { status: "verified" | "rejected" }> = {
                    status: record.ok ? "verified" : "rejected",
                    verificationId: record.verificationId,
                    programme: record.programme,
                    country: record.country,
                    ...(!record.ok ? { code: record.code } : {})
                }
                await runHook(ctx.hooks, "verify", "verifications", () => ctx.hooks?.onVerified?.(outcome))
            }
        }
        return status
    } catch (error) {
        await failed(ctx.hooks, "verify", "verifications", error)
        throw error
    }
}

export function cancelPresentation(ctx: MemberContext, requestId: string): Promise<200 | 409> {
    return ctx.server.cancelPresentationRequest(requestId)
}
