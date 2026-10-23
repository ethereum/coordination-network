import { describe, expect, it } from "@jest/globals"
import { createMemberFlows } from "../src/context"
import type { MemberContext } from "../src/context"
import {
    authAddress,
    config,
    createFakeLinkClient,
    createFakePolicy,
    createFakeServer,
    governanceSigner,
    metaStealthAddress,
    networkId,
    registrationSignResult,
    safeAddress,
    subject,
    txHash,
    verificationRecord
} from "./support"

describe("createMemberFlows", () => {
    it("binds each of the five subject-facing flows to the given context", async () => {
        const { client } = createFakeLinkClient({
            "registration.sign": async () => registrationSignResult,
            "credential.issue": async () => ({ status: "stored", credentialId: "urn:uuid:cred-1" }),
            "presentation.create": async () => ({ verificationId: "urn:uuid:verification-1" })
        })
        const ctx: MemberContext = {
            config,
            link: client,
            server: createFakeServer({
                submitRegistration: async () => ({ status: "submitted", txHash }),
                deliver: async () => ({ status: "announced", txHash }),
                createPresentationRequest: async () => ({
                    requestId: "urn:uuid:req-1",
                    challenge: `0x${"9c".repeat(31)}`,
                    audience: "urn:cn:network:member-server",
                    currentTime: 1_700_000_000,
                    programme: "demo-programme",
                    country: "ZZZ",
                    expiresAt: 1_700_000_300
                }),
                getVerification: async () => verificationRecord,
                revokeCredential: async () => ({ id: "urn:uuid:cred-1", revoked: true })
            }),
            policy: createFakePolicy()
        }

        const flows = createMemberFlows(ctx)

        await expect(flows.enrol()).resolves.toEqual({ status: "registered", subject, txHash, sponsorship: undefined })
        await expect(flows.issue({ subject })).resolves.toMatchObject({
            status: "issued",
            credentialId: "urn:uuid:cred-1"
        })
        await expect(flows.deliver({ networkId })).resolves.toMatchObject({ status: "announced", networkId })
        await expect(flows.verify({ programme: "demo-programme", country: "ZZZ" })).resolves.toMatchObject({
            status: "verified"
        })
        await expect(flows.revoke({ credentialId: "urn:uuid:cred-1" })).resolves.toEqual({
            status: "revoked",
            credentialId: "urn:uuid:cred-1"
        })
    })

    it("binds membershipStatus to the given context", async () => {
        const { client } = createFakeLinkClient({})
        const ctx: MemberContext = {
            config,
            link: client,
            server: createFakeServer({
                getMembership: async () => ({
                    status: "requested",
                    networkId,
                    authAddress,
                    governanceSigner,
                    metaStealthAddress,
                    safe: { address: safeAddress, threshold: 1, owners: [authAddress] },
                    identityRegistered: false,
                    issuerKeyPublished: false
                })
            }),
            policy: createFakePolicy()
        }

        const flows = createMemberFlows(ctx)

        await expect(flows.membershipStatus()).resolves.toMatchObject({ status: "requested" })
    })

    it("exposes exactly the surviving flows, not the governance flows this member's app no longer drives", () => {
        const { client } = createFakeLinkClient({})
        const ctx: MemberContext = {
            config,
            link: client,
            server: createFakeServer(),
            policy: createFakePolicy()
        }

        const flows = createMemberFlows(ctx)

        expect(Object.keys(flows).sort()).toEqual(
            [
                "deliver",
                "enrol",
                "issue",
                "membershipStatus",
                "revoke",
                "verify",
                "startPresentation",
                "presentationStatus",
                "cancelPresentation"
            ].sort()
        )
        expect(flows).not.toHaveProperty("requestToJoin")
        expect(flows).not.toHaveProperty("listJoinRequests")
        expect(flows).not.toHaveProperty("admit")
        expect(flows).not.toHaveProperty("registerMemberIdentity")
        expect(flows).not.toHaveProperty("publishIssuerKey")
    })
})
