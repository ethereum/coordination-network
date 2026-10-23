import type { ApprovalScope } from "@coordination-network/user-app-link"
import type { MemberPolicy } from "@coordination-network/network-member-app-core"

/** This member's fixed programme and country. A real member would look this up per user. */
export const APPROVAL_SCOPE: ApprovalScope = { programme: "demo-programme", country: "ZZZ" }

/**
 * The reference policy: both decisions run before the user app is asked anything, so they see
 * only the subject. Whether that person already holds one of this member's credentials is the
 * wallet's answer, arriving as the `alreadyHeld` outcome rather than as a refusal here - a real
 * member would decide from its own records instead, on eligibility it can check itself.
 */
export const policy: MemberPolicy = {
    // Neither decision looks at the identity it's handed: the reference member approves everyone.
    decideEnrolment() {
        return { approved: true, value: undefined }
    },

    decideIssuance() {
        return { approved: true, value: APPROVAL_SCOPE }
    }
}
