import type { RegistrationSignResult } from "@coordination-network/user-app-link"
import type { SubjectIdentity } from "../business"
import type { EnrolOutcome } from "../outcomes"
import type { MemberContext } from "../context"
import { failed, runHook } from "./shared"

export async function enrol(ctx: MemberContext): Promise<EnrolOutcome> {
    let signed: RegistrationSignResult
    try {
        signed = await ctx.link.request("registration.sign", {
            chainId: ctx.config.registry.chainId,
            verifyingContract: ctx.config.registry.verifyingContract
        })
    } catch (error) {
        return failed(ctx.hooks, "enrol", "registration.sign", error)
    }

    // networkId and metaStealthAddress are exactly what the wallet signed and the server records,
    // so a shown identity can never drift from a written one; securityLevel travels beside that
    // signed request, not inside it.
    const subject: SubjectIdentity = {
        networkId: signed.request.networkId,
        metaStealthAddress: signed.request.metaStealthAddress,
        securityLevel: signed.securityLevel
    }

    try {
        const decision = await ctx.policy.decideEnrolment(subject)
        if (!decision.approved) {
            return { status: "refused", reason: decision.reason, code: decision.code }
        }
    } catch (error) {
        return failed(ctx.hooks, "enrol", "policy", error)
    }

    try {
        const response = await ctx.server.submitRegistration(signed.request)

        if (response.status === "alreadyRegistered") {
            // A second member discovering the same person is already enrolled: a first-class
            // success, not an error, so it's returned here rather than thrown by submitRegistration.
            const outcome: Extract<EnrolOutcome, { status: "alreadyRegistered" }> = {
                status: "alreadyRegistered",
                subject,
                metaStealthAddress: response.metaStealthAddress,
                matchesRequest: response.matchesRequest
            }
            await runHook(ctx.hooks, "enrol", "registrations", () => ctx.hooks?.onEnrolled?.(outcome))
            return outcome
        }

        const outcome: Extract<EnrolOutcome, { status: "registered" }> = {
            status: "registered",
            subject,
            txHash: response.txHash,
            sponsorship: response.sponsorship
        }
        await runHook(ctx.hooks, "enrol", "registrations", () => ctx.hooks?.onEnrolled?.(outcome))
        return outcome
    } catch (error) {
        return failed(ctx.hooks, "enrol", "registrations", error)
    }
}
