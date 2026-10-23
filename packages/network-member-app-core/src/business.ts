import type { ApprovalScope, Hex32, Hex66, SecurityLevel } from "@coordination-network/user-app-link"
import type { DeliverOutcome, EnrolOutcome, IssueOutcome, RevokeOutcome, VerifyOutcome } from "./outcomes"

/** What a member app knows about the person it's dealing with, read off the signed registration request. */
export interface SubjectIdentity {
    networkId: Hex32
    metaStealthAddress: Hex66
    securityLevel: SecurityLevel
}

export type PolicyDecision<T> = { approved: true; value: T } | { approved: false; reason: string; code?: string }

/** The swap surface's decision points. A member replaces this, not the flows that call it. */
export interface MemberPolicy {
    decideEnrolment(subject: SubjectIdentity): PolicyDecision<void> | Promise<PolicyDecision<void>>
    /** Runs before the wallet is asked at all, so it decides from this member's own records only:
     *  whether the person already holds a credential is the wallet's answer, not an input here. */
    decideIssuance(subject: SubjectIdentity): PolicyDecision<ApprovalScope> | Promise<PolicyDecision<ApprovalScope>>
}

/** The flows a member app runs, named the same way everywhere so `onError` can say which one failed. */
export type FlowName = "enrol" | "issue" | "deliver" | "verify" | "revoke" | "membership"

export interface MemberHooks {
    onEnrolled?(outcome: Extract<EnrolOutcome, { status: "registered" | "alreadyRegistered" }>): void | Promise<void>
    onIssued?(outcome: Extract<IssueOutcome, { status: "issued" }>): void | Promise<void>
    onDelivered?(outcome: Extract<DeliverOutcome, { status: "announced" }>): void | Promise<void>
    onVerified?(outcome: Extract<VerifyOutcome, { status: "verified" | "rejected" }>): void | Promise<void>
    onRevoked?(outcome: Extract<RevokeOutcome, { status: "revoked" }>): void | Promise<void>
    /** Fires for a flow's own `failed` outcome, and for any hook above that throws instead of returning. */
    onError?(event: { flow: FlowName; stage: string; error: unknown }): void | Promise<void>
}

/** Honest about what the app's screens actually read: a display name. */
export interface MemberBranding {
    displayName: string
}

/** One bundle an app's `src/business/` exports; `policy` and `hooks` feed a `MemberContext`, `branding` feeds its screens. */
export interface MemberBusiness {
    policy: MemberPolicy
    hooks?: MemberHooks
    branding: MemberBranding
}
