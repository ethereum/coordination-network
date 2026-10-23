import type { ApprovalScope } from "@coordination-network/user-app-link"
import type { SubjectIdentity } from "../business"
import type { IssueOutcome } from "../outcomes"
import type { MemberContext } from "../context"
import { challengeUrl, credentialsUrl, issuersUrl, revocationsUrl } from "../server/urls"
import { failed, runHook } from "./shared"

export interface IssueInput {
    subject: SubjectIdentity
}

/**
 * One op behind one consent: the wallet takes the four URLs below and drives the whole issuance
 * against this member's server itself, so this flow decides the scope and reads the answer.
 */
export async function issue(ctx: MemberContext, input: IssueInput): Promise<IssueOutcome> {
    const { subject } = input

    let approvalScope: ApprovalScope
    try {
        const decision = await ctx.policy.decideIssuance(subject)
        if (!decision.approved) {
            return { status: "refused", reason: decision.reason, code: decision.code }
        }
        approvalScope = decision.value
    } catch (error) {
        return failed(ctx.hooks, "issue", "policy", error)
    }

    try {
        const result = await ctx.link.request("credential.issue", {
            issuerNetworkId: ctx.config.networkId,
            approvalScope,
            challengeUrl: challengeUrl(ctx.config.serverUrl),
            credentialsUrl: credentialsUrl(ctx.config.serverUrl),
            issuersUrl: issuersUrl(ctx.config.serverUrl),
            revocationsUrl: revocationsUrl(ctx.config.serverUrl)
        })

        if (result.status === "refused") {
            return { status: "refused", reason: result.message, code: result.code }
        }
        if (result.status === "alreadyHeld") {
            return { status: "alreadyHeld", credentialId: result.credentialId }
        }

        const outcome: Extract<IssueOutcome, { status: "issued" }> = {
            status: "issued",
            subject,
            credentialId: result.credentialId,
            approvalScope
        }
        await runHook(ctx.hooks, "issue", "credential.issue", () => ctx.hooks?.onIssued?.(outcome))
        return outcome
    } catch (error) {
        return failed(ctx.hooks, "issue", "credential.issue", error)
    }
}
