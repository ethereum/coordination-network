import { describe, expect, it, jest } from "@jest/globals"
import { LinkError } from "@coordination-network/user-app-link"
import { issue } from "../src/flows/issue"
import type { MemberContext } from "../src/context"
import { config, createFakeLinkClient, createFakePolicy, createFakeServer, subject } from "./support"

const approvalScope = { programme: "demo-programme", country: "ZZZ" }

function buildContext(overrides: Partial<MemberContext> = {}): MemberContext {
    const { client } = createFakeLinkClient({
        "credential.issue": async () => ({ status: "stored", credentialId: "urn:uuid:cred-1" })
    })
    return {
        config,
        link: client,
        server: createFakeServer(),
        policy: createFakePolicy(),
        ...overrides
    }
}

describe("issue", () => {
    it("issues a credential behind one op", async () => {
        const { client, calls } = createFakeLinkClient({
            "credential.issue": async () => ({ status: "stored", credentialId: "urn:uuid:cred-1" })
        })

        const outcome = await issue(buildContext({ link: client }), { subject })

        expect(outcome).toEqual({ status: "issued", subject, credentialId: "urn:uuid:cred-1", approvalScope })
        expect(calls.map((call) => call.op)).toEqual(["credential.issue"])
    })

    it("hands the wallet this member's network id, the approved scope and the four server URLs", async () => {
        const { client, calls } = createFakeLinkClient({
            "credential.issue": async () => ({ status: "stored", credentialId: "urn:uuid:cred-1" })
        })

        await issue(buildContext({ link: client }), { subject })

        expect(calls[0].params).toEqual({
            issuerNetworkId: config.networkId,
            approvalScope,
            challengeUrl: "https://issuer.example/v1/challenge",
            credentialsUrl: "https://issuer.example/v1/credentials",
            issuersUrl: "https://issuer.example/v1/issuers",
            revocationsUrl: "https://issuer.example/v1/revocations/snapshot"
        })
    })

    it("decides issuance from the subject alone, with nothing about what the wallet holds", async () => {
        const decideIssuance = jest.fn(async () => ({ approved: true as const, value: approvalScope }))

        await issue(buildContext({ policy: createFakePolicy({ decideIssuance }) }), { subject })

        expect(decideIssuance).toHaveBeenCalledWith(subject)
    })

    it("returns alreadyHeld when the wallet already holds one of this member's credentials", async () => {
        const { client } = createFakeLinkClient({
            "credential.issue": async () => ({ status: "alreadyHeld", credentialId: "urn:uuid:existing" })
        })

        const outcome = await issue(buildContext({ link: client }), { subject })

        expect(outcome).toEqual({ status: "alreadyHeld", credentialId: "urn:uuid:existing" })
    })

    it("returns the issuer server's own refusal as a refused outcome, not a failure", async () => {
        const { client } = createFakeLinkClient({
            "credential.issue": async () => ({
                status: "refused",
                code: "SUBJECT_MISMATCH",
                message: "the binding names another subject"
            })
        })

        const outcome = await issue(buildContext({ link: client }), { subject })

        expect(outcome).toEqual({
            status: "refused",
            reason: "the binding names another subject",
            code: "SUBJECT_MISMATCH"
        })
    })

    it("returns refused when policy declines issuance, without asking the wallet", async () => {
        const { client, calls } = createFakeLinkClient({})
        const ctx = buildContext({
            link: client,
            policy: createFakePolicy({
                decideIssuance: async () => ({ approved: false, reason: "not eligible", code: "INELIGIBLE" })
            })
        })

        const outcome = await issue(ctx, { subject })

        expect(outcome).toEqual({ status: "refused", reason: "not eligible", code: "INELIGIBLE" })
        expect(calls).toEqual([])
    })

    it("reports a failed outcome with stage policy when the policy throws", async () => {
        const ctx = buildContext({
            policy: createFakePolicy({
                decideIssuance: async () => {
                    throw new Error("policy backend unreachable")
                }
            })
        })

        const outcome = await issue(ctx, { subject })

        expect(outcome).toEqual({ status: "failed", stage: "policy", error: { message: "policy backend unreachable" } })
    })

    it("reports a failed outcome with stage credential.issue when the link rejects that step", async () => {
        const { client } = createFakeLinkClient({
            "credential.issue": async () => {
                throw new LinkError("ISSUER_UNREACHABLE", "the wallet could not reach the issuer")
            }
        })

        const outcome = await issue(buildContext({ link: client }), { subject })

        expect(outcome).toEqual({
            status: "failed",
            stage: "credential.issue",
            error: { message: "the wallet could not reach the issuer", code: "ISSUER_UNREACHABLE" }
        })
    })

    it("calls onIssued on success and never fails the flow when the hook itself throws", async () => {
        const onError = jest.fn((): void => {})
        const ctx = buildContext({
            hooks: {
                onIssued: () => {
                    throw new Error("hook boom")
                },
                onError
            }
        })

        const outcome = await issue(ctx, { subject })

        expect(outcome).toEqual({ status: "issued", subject, credentialId: "urn:uuid:cred-1", approvalScope })
        expect(onError).toHaveBeenCalledWith({ flow: "issue", stage: "credential.issue", error: expect.any(Error) })
    })
})
