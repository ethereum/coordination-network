import { describe, expect, it } from "@jest/globals"
import {
    createRequestHandler,
    decodeResponse,
    encodeRequest,
    type LinkOp,
    type Params
} from "@coordination-network/user-app-link"
import { buildConsentSummary } from "../src/consent"
import { createServiceHarness } from "./support/harness"
import { createMemberStack } from "./support/member-stack"

const CALLER = { name: "test-member", scheme: "testmember" }
const CALLBACK = "testmember://v1/response"

const registrationParams: Params<"registration.sign"> = { chainId: 1, verifyingContract: `0x${"11".repeat(20)}` }

const issueParams: Params<"credential.issue"> = {
    issuerNetworkId: `0x${"44".repeat(32)}`,
    approvalScope: { programme: "demo-programme", country: "ZZZ" },
    challengeUrl: "https://member.example/v1/challenge",
    credentialsUrl: "https://member.example/v1/credentials",
    issuersUrl: "https://member.example/v1/issuers",
    revocationsUrl: "https://member.example/v1/revocations/snapshot"
}

const presentationParams: Params<"presentation.create"> = {
    requestId: "req-1",
    challenge: `0x${"0d".repeat(31)}`,
    audience: "urn:cn:network:verifier",
    currentTime: 0,
    programme: "demo-programme",
    country: "ZZZ",
    issuersUrl: "https://member.example/v1/issuers",
    revocationsUrl: "https://member.example/v1/revocations/snapshot",
    responseUrl: "https://member.example/v1/verify"
}

function summaryFor(op: LinkOp, params: Params<LinkOp>, caller = CALLER) {
    return buildConsentSummary({ id: "r1", version: "v1", caller, callback: CALLBACK, op, params })
}

describe("consent is the single gate, checked before dispatch, for every op", () => {
    it.each<[LinkOp, () => Promise<Params<LinkOp>>]>([
        ["registration.sign", async () => registrationParams],
        [
            "credential.issue",
            async (): Promise<Params<"credential.issue">> => {
                const memberStack = await createMemberStack()
                return {
                    ...issueParams,
                    issuerNetworkId: memberStack.issuerNetworkId,
                    challengeUrl: memberStack.challengeUrl,
                    credentialsUrl: memberStack.credentialsUrl,
                    issuersUrl: memberStack.issuersUrl,
                    revocationsUrl: memberStack.revocationsUrl
                }
            }
        ],
        [
            "presentation.create",
            async (): Promise<Params<"presentation.create">> => {
                const memberStack = await createMemberStack()
                return {
                    ...presentationParams,
                    issuersUrl: memberStack.issuersUrl,
                    revocationsUrl: memberStack.revocationsUrl,
                    responseUrl: memberStack.verifyUrl
                }
            }
        ]
    ])("denies %s with USER_DENIED, without ever reaching the handler", async (op, buildParams) => {
        const harness = createServiceHarness()
        await harness.service.createIdentity()
        harness.consentAnswer.value = false

        const requestHandler = createRequestHandler({
            handlers: harness.service.handlers,
            consent: harness.service.consent
        })
        const params = await buildParams()
        // `op` is a runtime variable here, not a literal, so the op/params correlation `LinkRequest`
        // enforces at the type level has to be widened away — same reason `handler.ts` does it.
        const url = encodeRequest({ id: "r1", version: "v1", caller: CALLER, callback: CALLBACK, op, params } as never)

        const responseUrl = await requestHandler.handle(url)
        const response = decodeResponse(responseUrl)

        expect(response).toMatchObject({ ok: false, code: "USER_DENIED" })
        expect(harness.consentSeen).toHaveLength(1)
        expect(harness.consentSeen[0].op).toBe(op)
        expect(harness.http.posts).toEqual([])
    })
})

describe("buildConsentSummary's details name the concrete values approving would act on", () => {
    it("registration.sign names the callback, the contract the signature binds to, and the chain", () => {
        expect(summaryFor("registration.sign", registrationParams).details).toEqual([
            { label: "Callback", value: CALLBACK, truncate: false },
            { label: "Registry contract", value: `0x${"11".repeat(20)}` },
            { label: "Chain ID", value: "1" }
        ])
    })

    it("credential.issue names the issuer, its server, the programme, the country and the callback", () => {
        expect(summaryFor("credential.issue", issueParams).details).toEqual([
            { label: "Issuer", value: `0x${"44".repeat(32)}` },
            { label: "Issuer server", value: issueParams.credentialsUrl },
            { label: "Programme", value: "demo-programme" },
            { label: "Country", value: "ZZZ" },
            { label: "Callback", value: CALLBACK, truncate: false }
        ])
    })

    it("presentation.create names the verifier and the URL the proof is actually sent to", () => {
        expect(summaryFor("presentation.create", presentationParams).details).toEqual([
            { label: "Verifier", value: "urn:cn:network:verifier" },
            { label: "Proof is sent to", value: "https://member.example/v1/verify" },
            { label: "Callback", value: CALLBACK, truncate: false },
            { label: "Programme", value: "demo-programme" },
            { label: "Country", value: "ZZZ" }
        ])
    })
})

describe("buildConsentSummary carries the programme and country the wallet's sentence names", () => {
    it("reads credential.issue's from the approval scope", () => {
        expect(summaryFor("credential.issue", issueParams)).toMatchObject({
            scope: { programme: "demo-programme", country: "ZZZ" }
        })
    })

    it("reads presentation.create's from the request itself", () => {
        const params = { ...presentationParams, programme: "alt-programme", country: "ZZY" }

        expect(summaryFor("presentation.create", params)).toMatchObject({
            scope: { programme: "alt-programme", country: "ZZY" }
        })
    })
})
