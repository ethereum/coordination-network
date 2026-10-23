import type { IconName, OutcomeTone, StepDetail, StepState } from "@coordination-network/app-ui"
import type {
    EnrolOutcome,
    IssueOutcome,
    MembershipOutcome,
    SubjectIdentity
} from "@coordination-network/network-member-app-core"

/** What an `Outcome` shows, plus the rows that fold away beneath it. `StepDetail` is app-ui's
 *  label/value/mono row; here it fills a `Disclosure` rather than a step. */
export interface OutcomeView {
    tone: OutcomeTone
    icon: IconName
    title: string
    lines: string[]
    details: StepDetail[]
}

/**
 * The `SubjectIdentity` this org may issue against, or null when there is none. A record that
 * exists under another phone's stealth address is a different person's registration as far as
 * this org can tell, so Issue must not run against it.
 */
export function enrolledSubject(outcome: EnrolOutcome | null): SubjectIdentity | null {
    if (outcome === null) return null
    if (outcome.status === "registered") return outcome.subject
    return outcome.status === "alreadyRegistered" && outcome.matchesRequest ? outcome.subject : null
}

/** Whether to say, beside Register, that this org is not on the network yet and the registration
 *  will fail. A check that couldn't be read says nothing here: Settings reports membership, and it
 *  can admit it doesn't know rather than claiming a rejection. */
export function notAdmitted(membership: MembershipOutcome | null): boolean {
    return membership !== null && (membership.status === "none" || membership.status === "requested")
}

/** A record the network already held is not this run's success, so it takes the `existing` state
 *  rather than the green check - a record under another stealth address is a plain failure. */
export function registerStepState(outcome: EnrolOutcome | null): StepState {
    if (outcome === null) return "idle"
    switch (outcome.status) {
        case "registered":
            return "done"
        case "alreadyRegistered":
            return outcome.matchesRequest ? "existing" : "failed"
        case "refused":
        case "failed":
            return "failed"
    }
}

export function issueStepState(outcome: IssueOutcome | null): StepState {
    if (outcome === null) return "idle"
    switch (outcome.status) {
        case "issued":
            return "done"
        // Same reading as a registration that was already on chain: this run issued nothing.
        case "alreadyHeld":
            return "existing"
        case "refused":
        case "failed":
            return "failed"
    }
}

function sponsorshipDetails(outcome: Extract<EnrolOutcome, { status: "registered" }>): StepDetail[] {
    const { sponsorship } = outcome
    if (!sponsorship) return [{ label: "Transaction", value: outcome.txHash, mono: true }]
    return [
        { label: "Gas", value: sponsorship.actualGasCost, mono: true },
        { label: "Sender", value: sponsorship.sender, mono: true },
        { label: "Sender balance before", value: sponsorship.senderBalanceBefore, mono: true },
        { label: "Sender balance after", value: sponsorship.senderBalanceAfter, mono: true },
        { label: "Paymaster deposit before", value: sponsorship.paymasterDepositBefore, mono: true },
        { label: "Paymaster deposit after", value: sponsorship.paymasterDepositAfter, mono: true },
        { label: "User operation", value: sponsorship.userOpHash, mono: true },
        { label: "Bundle transaction", value: sponsorship.bundleTxHash, mono: true }
    ]
}

export function registerOutcomeView(outcome: EnrolOutcome | null): OutcomeView | null {
    if (outcome === null) return null
    switch (outcome.status) {
        case "registered":
            return {
                tone: "success",
                icon: "check-circle",
                title: "Registered",
                lines: [],
                details: sponsorshipDetails(outcome)
            }
        case "alreadyRegistered":
            return {
                tone: "neutral",
                icon: "users",
                title: "Already registered",
                lines: [outcome.matchesRequest ? "Matches this device" : "Different device", "Not counted twice"],
                details: [{ label: "Network ID", value: outcome.subject.networkId, mono: true }]
            }
        case "refused":
            return { tone: "danger", icon: "x-circle", title: "Refused", lines: [outcome.reason], details: [] }
        case "failed":
            return {
                tone: "danger",
                icon: "x-circle",
                title: "Failed",
                lines: [outcome.error.message],
                details: [{ label: "Stage", value: outcome.stage }]
            }
    }
}

export function issueOutcomeView(outcome: IssueOutcome | null): OutcomeView | null {
    if (outcome === null) return null
    switch (outcome.status) {
        case "issued":
            return {
                tone: "success",
                icon: "check-circle",
                title: "Credential issued",
                lines: [`${outcome.approvalScope.programme} · ${outcome.approvalScope.country}`],
                details: [{ label: "Credential id", value: outcome.credentialId, mono: true }]
            }
        case "alreadyHeld":
            return {
                tone: "neutral",
                icon: "credit-card",
                title: "Already issued",
                lines: ["Not issued twice"],
                details: [{ label: "Credential id", value: outcome.credentialId, mono: true }]
            }
        case "refused":
            return { tone: "danger", icon: "x-circle", title: "Refused", lines: [outcome.reason], details: [] }
        case "failed":
            return {
                tone: "danger",
                icon: "x-circle",
                title: "Failed",
                lines: [outcome.error.message],
                details: [{ label: "Stage", value: outcome.stage }]
            }
    }
}
