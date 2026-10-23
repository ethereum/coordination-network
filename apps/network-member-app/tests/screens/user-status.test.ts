import { describe, expect, it } from "@jest/globals"
import type { MembershipOutcome } from "@coordination-network/network-member-app-core"
import {
    enrolledSubject,
    issueOutcomeView,
    issueStepState,
    notAdmitted,
    registerOutcomeView,
    registerStepState
} from "../../src/screens/user-status"
import { hex } from "../support"

const subject = { networkId: hex(32, "11"), metaStealthAddress: hex(66, "22"), securityLevel: "SOFTWARE" as const }

const sponsorship = {
    sender: hex(20, "01"),
    senderBalanceBefore: "0",
    senderBalanceAfter: "0",
    userOpHash: hex(32, "02"),
    bundleTxHash: hex(32, "03"),
    actualGasCost: "1234",
    paymaster: hex(20, "04"),
    paymasterDepositBefore: "10",
    paymasterDepositAfter: "9"
}

function membership(status: "approved" | "requested" | "none" = "approved"): MembershipOutcome {
    return {
        status,
        networkId: hex(32, "aa"),
        authAddress: hex(20, "bb"),
        safe: { address: hex(20, "cc"), threshold: 1, owners: [hex(20, "bb")] },
        identityRegistered: true,
        issuerKeyPublished: true
    }
}

describe("enrolledSubject", () => {
    it("is null before anything has run", () => {
        expect(enrolledSubject(null)).toBeNull()
    })

    it("reads the subject off a fresh registration", () => {
        expect(enrolledSubject({ status: "registered", subject, txHash: hex(32, "aa") })).toEqual(subject)
    })

    it("reads the subject off a deduplicated registration that matches this device", () => {
        expect(
            enrolledSubject({
                status: "alreadyRegistered",
                subject,
                metaStealthAddress: subject.metaStealthAddress,
                matchesRequest: true
            })
        ).toEqual(subject)
    })

    it("is null when the existing record is under another device's stealth address", () => {
        expect(
            enrolledSubject({
                status: "alreadyRegistered",
                subject,
                metaStealthAddress: hex(66, "ff"),
                matchesRequest: false
            })
        ).toBeNull()
    })

    it("is null for a refusal or a failure", () => {
        expect(enrolledSubject({ status: "refused", reason: "no" })).toBeNull()
        expect(enrolledSubject({ status: "failed", stage: "policy", error: { message: "boom" } })).toBeNull()
    })
})

describe("registerStepState and registerOutcomeView", () => {
    it("folds the sponsorship away behind a registration that succeeded", () => {
        const outcome = { status: "registered" as const, subject, txHash: hex(32, "aa"), sponsorship }

        expect(registerStepState(outcome)).toBe("done")
        expect(registerOutcomeView(outcome)).toEqual({
            tone: "success",
            icon: "check-circle",
            title: "Registered",
            lines: [],
            details: [
                { label: "Gas", value: "1234", mono: true },
                { label: "Sender", value: sponsorship.sender, mono: true },
                { label: "Sender balance before", value: "0", mono: true },
                { label: "Sender balance after", value: "0", mono: true },
                { label: "Paymaster deposit before", value: "10", mono: true },
                { label: "Paymaster deposit after", value: "9", mono: true },
                { label: "User operation", value: sponsorship.userOpHash, mono: true },
                { label: "Bundle transaction", value: sponsorship.bundleTxHash, mono: true }
            ]
        })
    })

    it("folds the transaction hash away when the paymaster didn't sponsor the registration", () => {
        const outcome = { status: "registered" as const, subject, txHash: hex(32, "aa") }

        expect(registerOutcomeView(outcome)?.details).toEqual([
            { label: "Transaction", value: hex(32, "aa"), mono: true }
        ])
    })

    it("gives a matching existing registration the existing state and its own neutral outcome", () => {
        const outcome = {
            status: "alreadyRegistered" as const,
            subject,
            metaStealthAddress: subject.metaStealthAddress,
            matchesRequest: true
        }

        expect(registerStepState(outcome)).toBe("existing")
        expect(registerOutcomeView(outcome)).toEqual({
            tone: "neutral",
            icon: "users",
            title: "Already registered",
            lines: ["Matches this device", "Not counted twice"],
            details: [{ label: "Network ID", value: subject.networkId, mono: true }]
        })
    })

    it("says a record under another device's stealth address is a different device, and fails the step", () => {
        const outcome = {
            status: "alreadyRegistered" as const,
            subject,
            metaStealthAddress: hex(66, "ff"),
            matchesRequest: false
        }

        expect(registerStepState(outcome)).toBe("failed")
        expect(registerOutcomeView(outcome)?.lines).toEqual(["Different device", "Not counted twice"])
    })

    it("names the reason of a refusal and the stage of a failure", () => {
        expect(registerOutcomeView({ status: "refused", reason: "not eligible" })).toEqual({
            tone: "danger",
            icon: "x-circle",
            title: "Refused",
            lines: ["not eligible"],
            details: []
        })
        expect(registerOutcomeView({ status: "failed", stage: "policy", error: { message: "boom" } })).toEqual({
            tone: "danger",
            icon: "x-circle",
            title: "Failed",
            lines: ["boom"],
            details: [{ label: "Stage", value: "policy" }]
        })
    })

    it("is null before anything has run", () => {
        expect(registerOutcomeView(null)).toBeNull()
        expect(registerStepState(null)).toBe("idle")
    })
})

describe("issueStepState and issueOutcomeView", () => {
    it("leads with the programme and country, and folds the credential id away", () => {
        const outcome = {
            status: "issued" as const,
            subject,
            credentialId: "urn:uuid:cred-1",
            approvalScope: { programme: "demo-programme", country: "ZZZ" }
        }

        expect(issueStepState(outcome)).toBe("done")
        expect(issueOutcomeView(outcome)).toEqual({
            tone: "success",
            icon: "check-circle",
            title: "Credential issued",
            lines: ["demo-programme · ZZZ"],
            details: [{ label: "Credential id", value: "urn:uuid:cred-1", mono: true }]
        })
    })

    it("gives a credential the wallet already holds the existing state, never the green check", () => {
        const outcome = { status: "alreadyHeld" as const, credentialId: "urn:uuid:existing" }

        expect(issueStepState(outcome)).toBe("existing")
        expect(issueOutcomeView(outcome)).toEqual({
            tone: "neutral",
            icon: "credit-card",
            title: "Already issued",
            lines: ["Not issued twice"],
            details: [{ label: "Credential id", value: "urn:uuid:existing", mono: true }]
        })
    })

    it("names the reason of a refusal and the stage of a failure", () => {
        expect(issueOutcomeView({ status: "refused", reason: "not eligible for this programme" })?.lines).toEqual([
            "not eligible for this programme"
        ])

        const failure = issueOutcomeView({
            status: "failed",
            stage: "credential.issue",
            error: { message: "link timed out" }
        })
        expect(issueStepState({ status: "failed", stage: "credential.issue", error: { message: "x" } })).toBe("failed")
        expect(failure).toEqual({
            tone: "danger",
            icon: "x-circle",
            title: "Failed",
            lines: ["link timed out"],
            details: [{ label: "Stage", value: "credential.issue" }]
        })
    })

    it("is null before anything has run", () => {
        expect(issueOutcomeView(null)).toBeNull()
        expect(issueStepState(null)).toBe("idle")
    })
})

describe("notAdmitted", () => {
    it("says nothing before membership has loaded, or once this org is approved", () => {
        expect(notAdmitted(null)).toBe(false)
        expect(notAdmitted(membership("approved"))).toBe(false)
    })

    it("warns while this org is only requested or not a member at all", () => {
        expect(notAdmitted(membership("requested"))).toBe(true)
        expect(notAdmitted(membership("none"))).toBe(true)
    })

    it("stays quiet when the check itself failed, rather than claiming a rejection", () => {
        expect(notAdmitted({ status: "failed", stage: "membershipStatus", error: { message: "boom" } })).toBe(false)
    })
})
