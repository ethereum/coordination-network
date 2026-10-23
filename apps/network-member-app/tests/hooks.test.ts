import { beforeEach, describe, expect, it } from "@jest/globals"
import type { ActivityEntry } from "../src/business/hooks"
import { clearActivity, hooks, subscribeToActivity } from "../src/business/hooks"
import { hex } from "./support"

const subject = { networkId: hex(32, "11"), metaStealthAddress: hex(66, "22"), securityLevel: "SOFTWARE" as const }

function issued(credentialId: string) {
    return {
        status: "issued" as const,
        subject,
        credentialId,
        approvalScope: { programme: "demo-programme", country: "ZZZ" }
    }
}

/** Subscribes and hands back a live reader, so a test can call a hook and then check what it recorded. */
function record(): { entries: () => ActivityEntry[]; unsubscribe: () => void } {
    let entries: ActivityEntry[] = []
    const unsubscribe = subscribeToActivity((next) => {
        entries = next
    })
    return { entries: () => entries, unsubscribe }
}

describe("business/hooks", () => {
    beforeEach(() => {
        clearActivity()
    })

    it("appends the newest entry first", () => {
        const log = record()

        hooks.onIssued?.(issued("cred-1"))
        hooks.onIssued?.(issued("cred-2"))

        expect(log.entries().map((entry) => entry.message)).toEqual(["issued a credential", "issued a credential"])
        expect(log.entries()).toEqual([
            expect.objectContaining({ flow: "issue" }),
            expect.objectContaining({ flow: "issue" })
        ])
        log.unsubscribe()
    })

    it("distinguishes a fresh registration from a deduplicated one", () => {
        const log = record()

        hooks.onEnrolled?.({ status: "registered", subject, txHash: hex(32, "aa") })
        hooks.onEnrolled?.({
            status: "alreadyRegistered",
            subject,
            metaStealthAddress: subject.metaStealthAddress,
            matchesRequest: true
        })

        expect(log.entries()[0].message).toContain("already registered")
        expect(log.entries()[1].message).toContain("registered")
        expect(log.entries()[1].message).not.toContain("already")
        log.unsubscribe()
    })

    it("tones a rejected verification as an error", () => {
        const log = record()

        hooks.onVerified?.({
            status: "rejected",
            code: "ISSUER_ROOT_MISMATCH",
            verificationId: "urn:uuid:verification-1",
            programme: "demo-programme",
            country: "ZZZ"
        })

        expect(log.entries()[0]).toMatchObject({ tone: "error", flow: "verify", message: "rejected a presentation" })
        log.unsubscribe()
    })

    it("tones an accepted verification as info", () => {
        const log = record()

        hooks.onVerified?.({
            status: "verified",
            verificationId: "urn:uuid:verification-1",
            programme: "demo-programme",
            country: "ZZZ"
        })

        expect(log.entries()[0]).toMatchObject({ tone: "info", flow: "verify", message: "verified a presentation" })
        log.unsubscribe()
    })

    it("appends an issued credential to the log, with no id in the message", () => {
        const log = record()

        hooks.onIssued?.({
            status: "issued",
            subject,
            credentialId: "urn:uuid:cred-1",
            approvalScope: { programme: "demo-programme", country: "ZZZ" }
        })

        expect(log.entries()[0]).toMatchObject({ tone: "info", flow: "issue", message: "issued a credential" })
        log.unsubscribe()
    })

    it("records onError with the flow, stage and underlying message", () => {
        const log = record()

        hooks.onError?.({ flow: "verify", stage: "presentation.create", error: new Error("proof rejected") })

        expect(log.entries()[0]).toMatchObject({
            tone: "error",
            flow: "verify",
            message: "verify: failed at presentation.create - proof rejected"
        })
        log.unsubscribe()
    })

    it("stops updating once unsubscribed, and clearActivity empties the log", () => {
        const log = record()
        log.unsubscribe()

        hooks.onIssued?.(issued("cred-3"))
        expect(log.entries()).toEqual([])

        const log2 = record()
        hooks.onIssued?.(issued("cred-4"))
        clearActivity()
        expect(log2.entries()).toEqual([])
        log2.unsubscribe()
    })
})
