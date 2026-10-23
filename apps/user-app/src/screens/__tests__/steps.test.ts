import { CREDENTIAL_ISSUE_STEPS } from "@coordination-network/user-app-core"
import { stepsFor } from "../steps"

describe("stepsFor", () => {
    it("shows issuance as the three steps the consent screen promised, all idle before any report", () => {
        expect(stepsFor("credential.issue", null)).toEqual([
            { key: "status", title: "Checking your credential status", state: "idle" },
            { key: "binding", title: "Binding the credential", state: "idle" },
            { key: "storing", title: "Storing the credential", state: "idle" }
        ])
    })

    // The handler reports six; a person approved three, and watches those three. Naming the six
    // through the handler's own constants is what keeps the two lists from drifting apart.
    it.each([
        [CREDENTIAL_ISSUE_STEPS.held, ["running", "idle", "idle"]],
        [CREDENTIAL_ISSUE_STEPS.lists, ["running", "idle", "idle"]],
        [CREDENTIAL_ISSUE_STEPS.challenge, ["done", "running", "idle"]],
        [CREDENTIAL_ISSUE_STEPS.binding, ["done", "running", "idle"]],
        [CREDENTIAL_ISSUE_STEPS.signing, ["done", "running", "idle"]],
        [CREDENTIAL_ISSUE_STEPS.storing, ["done", "done", "running"]]
    ])("maps the issuance report %s onto them", (reported, states) => {
        expect(stepsFor("credential.issue", reported).map((step) => step.state)).toEqual(states)
    })

    it("groups every step the handler reports, so none of them leaves the list idle", () => {
        for (const reported of Object.values(CREDENTIAL_ISSUE_STEPS)) {
            expect(stepsFor("credential.issue", reported).map((step) => step.state)).toContain("running")
        }
    })

    it("shows a presentation's own three steps as the handler reports them", () => {
        expect(stepsFor("presentation.create", "Proving")).toEqual([
            { key: "checking", title: "Checking your credential", state: "done" },
            { key: "proving", title: "Proving", state: "running" },
            { key: "sharing", title: "Sharing", state: "idle" }
        ])
    })

    it("lists no steps for a registration, which signs in one go and reports none", () => {
        expect(stepsFor("registration.sign", null)).toEqual([])
    })
})
