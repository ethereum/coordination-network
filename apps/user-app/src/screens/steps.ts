import type { Step, StepState } from "@coordination-network/app-ui"
import { CREDENTIAL_ISSUE_STEPS } from "@coordination-network/user-app-core"
import type { LinkOp } from "@coordination-network/user-app-link"

interface StepGroup {
    key: string
    title: string
    /** The handler's own `progress` names that put this step in progress. */
    reports: string[]
}

/**
 * What the sheet shows a flow doing, in the words the consent screen used rather than the
 * handler's. Issuance promises three steps and then reports six, so the six group onto the three:
 * a person watches the list they approved, not a longer one that appeared afterwards.
 */
const OP_STEPS: Record<LinkOp, StepGroup[]> = {
    "registration.sign": [],
    "credential.issue": [
        {
            key: "status",
            title: "Checking your credential status",
            reports: [CREDENTIAL_ISSUE_STEPS.held, CREDENTIAL_ISSUE_STEPS.lists]
        },
        {
            key: "binding",
            title: "Binding the credential",
            reports: [CREDENTIAL_ISSUE_STEPS.challenge, CREDENTIAL_ISSUE_STEPS.binding, CREDENTIAL_ISSUE_STEPS.signing]
        },
        { key: "storing", title: "Storing the credential", reports: [CREDENTIAL_ISSUE_STEPS.storing] }
    ],
    "presentation.create": [
        { key: "checking", title: "Checking your credential", reports: ["Checking your credential"] },
        { key: "proving", title: "Proving", reports: ["Proving"] },
        { key: "sharing", title: "Sharing", reports: ["Sharing"] }
    ]
}

function stateAt(index: number, running: number): StepState {
    if (index < running) return "done"
    return index === running ? "running" : "idle"
}

/** The op's steps, the last reported one running and everything before it done. */
export function stepsFor(op: LinkOp, reported: string | null): Step[] {
    const groups = OP_STEPS[op]
    const running = reported === null ? -1 : groups.findIndex((group) => group.reports.includes(reported))
    return groups.map(({ key, title }, index) => ({ key, title, state: stateAt(index, running) }))
}
