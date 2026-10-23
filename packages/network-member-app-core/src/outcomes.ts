import type { ApprovalScope, Hex32, Hex66 } from "@coordination-network/user-app-link"
import type { SubjectIdentity } from "./business"
import type { MembershipStatusResponse, Sponsorship } from "./server/client"

/**
 * Normalized shape of whatever a flow catches - a LinkError, a MemberServerError, or an unexpected
 * throw. No `cause`: an outcome is a value a screen can hold onto and log, and the routes this
 * package talks to are deliberately careful not to echo request internals into error messages.
 */
export interface FlowError {
    message: string
    code?: string
}

/** The one variant every flow outcome shares: which stage threw, and what. */
export type Failed<Stage extends string> = { status: "failed"; stage: Stage; error: FlowError }

export type EnrolStage = "registration.sign" | "policy" | "registrations"

export type EnrolOutcome =
    | { status: "registered"; subject: SubjectIdentity; txHash: Hex32; sponsorship?: Sponsorship }
    | { status: "alreadyRegistered"; subject: SubjectIdentity; metaStealthAddress: Hex66; matchesRequest: boolean }
    | { status: "refused"; reason: string; code?: string }
    | Failed<EnrolStage>

export type IssueStage = "policy" | "credential.issue"

export type IssueOutcome =
    | { status: "issued"; subject: SubjectIdentity; credentialId: string; approvalScope: ApprovalScope }
    // The wallet already held one of this member's credentials and issued nothing: a first-class
    // answer, since the member cannot know this before asking.
    | { status: "alreadyHeld"; credentialId: string }
    // Either this member's own policy or its server declining - `code` and `reason` are whichever
    // one spoke.
    | { status: "refused"; reason: string; code?: string }
    | Failed<IssueStage>

export type DeliverStage = "deliveries"

export type DeliverOutcome = { status: "announced"; networkId: Hex32; txHash: Hex32 } | Failed<DeliverStage>

export type VerifyStage = "presentationRequests" | "presentation.create" | "verifications"

export type VerifyOutcome =
    | { status: "verified"; verificationId: string; programme: string; country: string }
    // `code` is this member's own server's vocabulary - a verification failure it recorded
    // (e.g. ISSUER_ROOT_MISMATCH), or the refusal the wallet reported and the request was closed
    // with (CREDENTIAL_REVOKED, NO_CREDENTIAL). Never a value the wallet relayed about the proof.
    | { status: "rejected"; code?: string; verificationId: string; programme: string; country: string }
    | Failed<VerifyStage>

export type RevokeStage = "revoke"

export type RevokeOutcome = { status: "revoked"; credentialId: string } | Failed<RevokeStage>

/** This flow is a single server round trip, so a `failed` outcome's stage just names the flow. */
export type MembershipStage = "membershipStatus"

/** Same shape `getMembership()` answers with, minus `metaStealthAddress` and `governanceSigner`:
 *  a screen showing this member's own status has no use for the subject's stealth address or the
 *  network's governance signer. */
export type MembershipOutcome =
    Omit<MembershipStatusResponse, "metaStealthAddress" | "governanceSigner"> | Failed<MembershipStage>
