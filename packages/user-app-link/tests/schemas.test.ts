import { describe, it, expect } from "@jest/globals"
import type { z } from "zod"
import {
    ALLOWED_ENDPOINT_URL_SCHEMES,
    DENIED_CALLBACK_SCHEMES,
    callbackSchema,
    callerSchema,
    hex20Schema,
    hex31Schema,
    hex32Schema,
    hex65Schema,
    hex66Schema,
    linkErrorCodeSchema,
    linkRequestEnvelopeSchema,
    linkRequestSchema,
    linkResponseSchema,
    paramsSchemas,
    resultSchemas,
    securityLevelSchema
} from "../src/schemas"
import { LINK_OPS, type LinkOp, type Params, type Result } from "../src/types"
import * as fixtures from "./fixtures"

type OpFixture<Op extends LinkOp = LinkOp> = Op extends LinkOp
    ? { op: Op; params: Params<Op>; result: Result<Op> }
    : never

const opFixtures: OpFixture[] = [
    { op: "registration.sign", params: fixtures.registrationSignParams, result: fixtures.registrationSignResult },
    { op: "credential.issue", params: fixtures.credentialIssueParams, result: fixtures.credentialIssueResult },
    { op: "presentation.create", params: fixtures.presentationCreateParams, result: fixtures.presentationCreateResult }
]

/** Round 5 merged six ops into three; a caller still on the old vocabulary must be refused, not guessed at. */
const RETIRED_OPS = ["identity.get", "issuance.bind", "credential.store", "credential.status"]

describe("hex schemas", () => {
    const cases: [name: string, schema: z.ZodTypeAny, byteLength: number][] = [
        ["hex20Schema", hex20Schema, 20],
        ["hex31Schema", hex31Schema, 31],
        ["hex32Schema", hex32Schema, 32],
        ["hex65Schema", hex65Schema, 65],
        ["hex66Schema", hex66Schema, 66]
    ]

    for (const [name, schema, byteLength] of cases) {
        it(`${name} accepts exactly ${byteLength} bytes and lowercases them`, () => {
            const value = `0x${"AB".repeat(byteLength)}`
            const parsed = schema.safeParse(value)
            expect(parsed.success).toBe(true)
            expect(parsed.success && parsed.data).toBe(value.toLowerCase())
        })

        it(`${name} rejects a value one byte short`, () => {
            const tooShort = `0x${"ab".repeat(byteLength - 1)}`
            expect(schema.safeParse(tooShort).success).toBe(false)
        })

        it(`${name} rejects a value missing the 0x prefix`, () => {
            expect(schema.safeParse("ab".repeat(byteLength)).success).toBe(false)
        })
    }
})

describe("the op list", () => {
    it("carries exactly the three round-5 operations", () => {
        expect([...LINK_OPS]).toEqual(["registration.sign", "credential.issue", "presentation.create"])
    })

    it.each(RETIRED_OPS)("no longer carries %s", (op) => {
        expect(LINK_OPS as readonly string[]).not.toContain(op)
        expect(Object.keys(paramsSchemas)).not.toContain(op)
        expect(Object.keys(resultSchemas)).not.toContain(op)
    })
})

describe("securityLevelSchema", () => {
    it.each(["STRONGBOX", "TRUSTED_ENVIRONMENT", "SOFTWARE", "UNKNOWN"])("accepts %s", (level) => {
        expect(securityLevelSchema.safeParse(level).success).toBe(true)
    })

    it("rejects a level outside the enum", () => {
        expect(securityLevelSchema.safeParse("HARDWARE").success).toBe(false)
    })
})

describe("callerSchema", () => {
    it("accepts a name and scheme", () => {
        expect(callerSchema.safeParse(fixtures.caller).success).toBe(true)
    })

    it("rejects a missing scheme", () => {
        expect(callerSchema.safeParse({ name: "App" }).success).toBe(false)
    })

    it("rejects an unlisted extra field", () => {
        expect(callerSchema.safeParse({ ...fixtures.caller, appId: "com.example.app" }).success).toBe(false)
    })

    it("rejects a name carrying a newline", () => {
        expect(callerSchema.safeParse({ ...fixtures.caller, name: "Member App\nSign you up for free" }).success).toBe(
            false
        )
    })

    it("rejects a name carrying a bidi override, which reorders the words after it", () => {
        expect(callerSchema.safeParse({ ...fixtures.caller, name: "Member App‮" }).success).toBe(false)
    })

    it("accepts a name with an accent or a non-Latin script", () => {
        expect(callerSchema.safeParse({ ...fixtures.caller, name: "Öko-Verband 東京" }).success).toBe(true)
    })
})

describe("callbackSchema", () => {
    it("accepts a custom app scheme", () => {
        expect(callbackSchema.safeParse(fixtures.callback).success).toBe(true)
    })

    it("rejects a callback with a query string", () => {
        expect(callbackSchema.safeParse("memberapp://v1/response?src=userapp").success).toBe(false)
    })

    it("rejects a callback with a fragment", () => {
        expect(callbackSchema.safeParse("memberapp://v1/response#section").success).toBe(false)
    })

    it.each(DENIED_CALLBACK_SCHEMES)("rejects the %s scheme", (scheme) => {
        expect(callbackSchema.safeParse(`${scheme}://blocked`).success).toBe(false)
    })

    it.each(DENIED_CALLBACK_SCHEMES)("rejects the %s scheme regardless of case", (scheme) => {
        expect(callbackSchema.safeParse(`${scheme.toUpperCase()}://blocked`).success).toBe(false)
    })
})

describe("per-op params and result schemas", () => {
    for (const { op, params, result } of opFixtures) {
        it(`paramsSchemas["${op}"] accepts the fixture params`, () => {
            expect(paramsSchemas[op].safeParse(params).success).toBe(true)
        })

        it(`resultSchemas["${op}"] accepts the fixture result`, () => {
            expect(resultSchemas[op].safeParse(result).success).toBe(true)
        })
    }

    it("registrationSignResultSchema wraps the signed request and names the security level", () => {
        const flat = { ...fixtures.registrationSignResult.request, securityLevel: "SOFTWARE" }
        expect(resultSchemas["registration.sign"].safeParse(flat).success).toBe(false)
        const unknownLevel = { ...fixtures.registrationSignResult, securityLevel: "HARDWARE" }
        expect(resultSchemas["registration.sign"].safeParse(unknownLevel).success).toBe(false)
    })

    it("registrationSignResultSchema rejects a missing securityLevel", () => {
        const withoutLevel: Record<string, unknown> = { ...fixtures.registrationSignResult }
        delete withoutLevel.securityLevel
        expect(resultSchemas["registration.sign"].safeParse(withoutLevel).success).toBe(false)
    })

    it("registrationSignParamsSchema rejects a verifyingContract one byte short", () => {
        const badParams = {
            ...fixtures.registrationSignParams,
            verifyingContract: fixtures.registrationSignParams.verifyingContract.slice(0, -2)
        }
        expect(paramsSchemas["registration.sign"].safeParse(badParams).success).toBe(false)
    })

    it("credentialIssueResultSchema accepts each of the three outcomes", () => {
        for (const result of [
            { status: "stored", credentialId: "cred-1" },
            { status: "alreadyHeld", credentialId: "cred-1" },
            { status: "refused", code: "NOT_APPROVED", message: "this member has not approved you" }
        ]) {
            expect(resultSchemas["credential.issue"].safeParse(result).success).toBe(true)
        }
    })

    it("credentialIssueResultSchema rejects an outcome mixing two statuses' fields", () => {
        expect(
            resultSchemas["credential.issue"].safeParse({ status: "stored", code: "NOT_APPROVED", message: "" }).success
        ).toBe(false)
        expect(resultSchemas["credential.issue"].safeParse({ status: "issued", credentialId: "c" }).success).toBe(false)
    })

    it("presentationCreateParamsSchema rejects an empty requestId", () => {
        const badParams = { ...fixtures.presentationCreateParams, requestId: "" }
        expect(paramsSchemas["presentation.create"].safeParse(badParams).success).toBe(false)
    })

    it("presentationCreateParamsSchema rejects a requestId over 128 characters", () => {
        const badParams = { ...fixtures.presentationCreateParams, requestId: "r".repeat(129) }
        expect(paramsSchemas["presentation.create"].safeParse(badParams).success).toBe(false)
    })

    it("presentationCreateParamsSchema accepts a requestId at exactly 128 characters", () => {
        const okParams = { ...fixtures.presentationCreateParams, requestId: "r".repeat(128) }
        expect(paramsSchemas["presentation.create"].safeParse(okParams).success).toBe(true)
    })

    // The caller reads the outcome from its own server under this id, so a response without one
    // is unusable rather than a relayable failure.
    it("presentationCreateResultSchema requires a verificationId and nothing else", () => {
        expect(resultSchemas["presentation.create"].safeParse({ ok: false, code: "UNKNOWN_REQUEST" }).success).toBe(
            false
        )
        expect(
            resultSchemas["presentation.create"].safeParse({ verificationId: "verification-1", ok: true }).success
        ).toBe(false)
    })

    // The user app renders this on its consent screen; an unbounded one can push the Approve and
    // Deny buttons, and the callback that is the only anti-spoofing signal, off the screen.
    it("callerSchema bounds the name a caller can put on the consent screen", () => {
        expect(callerSchema.safeParse({ name: "a".repeat(64), scheme: "x" }).success).toBe(true)
        expect(callerSchema.safeParse({ name: "a".repeat(65), scheme: "x" }).success).toBe(false)
    })

    it("credentialIssueParamsSchema requires all four endpoint URLs", () => {
        for (const field of ["challengeUrl", "credentialsUrl", "issuersUrl", "revocationsUrl"]) {
            expect(
                paramsSchemas["credential.issue"].safeParse({ ...fixtures.credentialIssueParams, [field]: undefined })
                    .success
            ).toBe(false)
            expect(
                paramsSchemas["credential.issue"].safeParse({ ...fixtures.credentialIssueParams, [field]: "nope" })
                    .success
            ).toBe(false)
        }
    })

    it("credentialIssueParamsSchema accepts the four endpoint URLs when they share one origin", () => {
        expect(paramsSchemas["credential.issue"].safeParse(fixtures.credentialIssueParams).success).toBe(true)
    })

    // The wallet keeps revocationsUrl for the credential's life and never shows it again, so a
    // caller that drives a genuine issuance could point later revocation reads at itself.
    it("credentialIssueParamsSchema names the field whose origin differs from the rest", () => {
        const params = {
            ...fixtures.credentialIssueParams,
            revocationsUrl: "https://elsewhere.example/v1/revocations/snapshot"
        }
        const result = paramsSchemas["credential.issue"].safeParse(params)

        expect(result.success).toBe(false)
        expect(result.error?.issues[0]).toMatchObject({
            path: ["revocationsUrl"],
            message: expect.stringContaining("revocationsUrl")
        })
    })

    it.each(["challengeUrl", "credentialsUrl", "issuersUrl"])(
        "credentialIssueParamsSchema rejects a %s on another host",
        (field) => {
            const params = { ...fixtures.credentialIssueParams, [field]: `https://elsewhere.example/v1/${field}` }
            expect(paramsSchemas["credential.issue"].safeParse(params).success).toBe(false)
        }
    )

    it("credentialIssueParamsSchema rejects a port or scheme that differs from the rest", () => {
        const onAnotherPort = {
            ...fixtures.credentialIssueParams,
            issuersUrl: "https://issuer.example:8443/v1/issuers"
        }
        const onAnotherScheme = { ...fixtures.credentialIssueParams, issuersUrl: "http://issuer.example/v1/issuers" }

        expect(paramsSchemas["credential.issue"].safeParse(onAnotherPort).success).toBe(false)
        expect(paramsSchemas["credential.issue"].safeParse(onAnotherScheme).success).toBe(false)
    })

    // programme is interpolated into the caption sentence the same way caller.name is, for both
    // credential.issue (approvalScope.programme) and presentation.create, so it gets the same bound.
    it("credentialIssueParamsSchema bounds the programme a caller can put in the consent caption", () => {
        const withProgramme = (programme: string) => ({
            ...fixtures.credentialIssueParams,
            approvalScope: { ...fixtures.credentialIssueParams.approvalScope, programme }
        })
        expect(paramsSchemas["credential.issue"].safeParse(withProgramme("a".repeat(64))).success).toBe(true)
        expect(paramsSchemas["credential.issue"].safeParse(withProgramme("a".repeat(65))).success).toBe(false)
    })

    it("credentialIssueParamsSchema rejects a programme carrying a bidi override, which reorders the caption after it", () => {
        const params = {
            ...fixtures.credentialIssueParams,
            approvalScope: { ...fixtures.credentialIssueParams.approvalScope, programme: "demo-programme‮" }
        }
        expect(paramsSchemas["credential.issue"].safeParse(params).success).toBe(false)
    })

    // The verifier would otherwise choose which revocation snapshot its own proof is checked
    // against; the wallet reads the issuer's from its own index instead.
    it("presentationCreateParamsSchema refuses a verifier-supplied revocationsUrl", () => {
        const params = {
            ...fixtures.presentationCreateParams,
            revocationsUrl: "https://verifier.example/v1/revocations/snapshot"
        }
        expect(paramsSchemas["presentation.create"].safeParse(params).success).toBe(false)
    })

    it("presentationCreateParamsSchema bounds the programme a caller can put in the consent caption", () => {
        const at64 = { ...fixtures.presentationCreateParams, programme: "a".repeat(64) }
        const at65 = { ...fixtures.presentationCreateParams, programme: "a".repeat(65) }
        expect(paramsSchemas["presentation.create"].safeParse(at64).success).toBe(true)
        expect(paramsSchemas["presentation.create"].safeParse(at65).success).toBe(false)
    })

    it("presentationCreateParamsSchema rejects a programme carrying a bidi override, which reorders the caption after it", () => {
        const params = { ...fixtures.presentationCreateParams, programme: "demo-programme‮" }
        expect(paramsSchemas["presentation.create"].safeParse(params).success).toBe(false)
    })

    // U+2028/U+2029 are Zl/Zp, not Cc/Cf, so a regex that only excludes control and formatting
    // characters lets them through; they render as a line break same as \n does.
    it("presentationCreateParamsSchema rejects a programme carrying a line separator", () => {
        const params = { ...fixtures.presentationCreateParams, programme: "demo programme" }
        expect(paramsSchemas["presentation.create"].safeParse(params).success).toBe(false)
    })

    it("presentationCreateParamsSchema accepts an ordinary programme name", () => {
        expect(paramsSchemas["presentation.create"].safeParse(fixtures.presentationCreateParams).success).toBe(true)
    })
})

describe("endpoint URL scheme allowlist", () => {
    // Every endpoint field on both ops resolves to the same urlLikeSchema, so covering
    // credential.issue's four and presentation.create's two covers it everywhere.
    const deniedEndpointSchemes = ["file", "content", "javascript", "data", "intent"]
    const issueUrlFields = ["challengeUrl", "credentialsUrl", "issuersUrl", "revocationsUrl"] as const

    for (const field of issueUrlFields) {
        it.each(deniedEndpointSchemes)(`credential.issue's ${field} rejects the %s scheme`, (scheme) => {
            const params = { ...fixtures.credentialIssueParams, [field]: `${scheme}://blocked` }
            expect(paramsSchemas["credential.issue"].safeParse(params).success).toBe(false)
        })
    }

    it.each(deniedEndpointSchemes)("presentation.create's issuersUrl rejects the %s scheme", (scheme) => {
        const params = { ...fixtures.presentationCreateParams, issuersUrl: `${scheme}://blocked` }
        expect(paramsSchemas["presentation.create"].safeParse(params).success).toBe(false)
    })

    it.each(deniedEndpointSchemes)("presentation.create's responseUrl rejects the %s scheme", (scheme) => {
        const params = { ...fixtures.presentationCreateParams, responseUrl: `${scheme}://blocked` }
        expect(paramsSchemas["presentation.create"].safeParse(params).success).toBe(false)
    })

    // All four move together: they have to share one origin, so a scheme is only testable on the
    // whole set.
    const issueParamsOn = (origin: string) => ({
        ...fixtures.credentialIssueParams,
        challengeUrl: `${origin}/v1/challenge`,
        credentialsUrl: `${origin}/v1/credentials`,
        issuersUrl: `${origin}/v1/issuers`,
        revocationsUrl: `${origin}/v1/revocations/snapshot`
    })

    it.each(ALLOWED_ENDPOINT_URL_SCHEMES)("credential.issue's endpoint URLs accept the %s scheme", (scheme) => {
        expect(paramsSchemas["credential.issue"].safeParse(issueParamsOn(`${scheme}://issuer.example`)).success).toBe(
            true
        )
    })

    // The verifier's three move together for the same reason.
    const presentationParamsOn = (origin: string) => ({
        ...fixtures.presentationCreateParams,
        issuersUrl: `${origin}/v1/issuers`,
        revocationsUrl: `${origin}/v1/revocations/snapshot`,
        responseUrl: `${origin}/v1/verify`
    })

    it.each(ALLOWED_ENDPOINT_URL_SCHEMES)("presentation.create's endpoint URLs accept the %s scheme", (scheme) => {
        expect(
            paramsSchemas["presentation.create"].safeParse(presentationParamsOn(`${scheme}://member.example`)).success
        ).toBe(true)
    })

    // The local stack serves these endpoints over plain http on a LAN address; http must stay
    // usable there, not just for a public hostname.
    it("credential.issue's endpoint URLs accept an http:// LAN-style host", () => {
        expect(paramsSchemas["credential.issue"].safeParse(issueParamsOn("http://192.168.1.20:8080")).success).toBe(
            true
        )
    })

    it("presentation.create's endpoint URLs accept an http:// LAN-style host", () => {
        expect(
            paramsSchemas["presentation.create"].safeParse(presentationParamsOn("http://192.168.1.20:8080")).success
        ).toBe(true)
    })
})

describe("linkRequestEnvelopeSchema", () => {
    function envelope(overrides: Record<string, unknown> = {}) {
        return {
            id: "req-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams,
            ...overrides
        }
    }

    it("accepts a well-formed envelope regardless of op or params", () => {
        expect(
            linkRequestEnvelopeSchema.safeParse(envelope({ op: "future.op", params: { anything: 1 } })).success
        ).toBe(true)
    })

    it("rejects the wrong version", () => {
        expect(linkRequestEnvelopeSchema.safeParse(envelope({ version: "v2" })).success).toBe(false)
    })

    it("rejects an unlisted top-level extra field", () => {
        expect(linkRequestEnvelopeSchema.safeParse(envelope({ extra: true })).success).toBe(false)
    })

    it("rejects a missing callback", () => {
        const request = { id: "req-1", version: "v1", caller: fixtures.caller, op: "registration.sign", params: {} }
        expect(linkRequestEnvelopeSchema.safeParse(request).success).toBe(false)
    })

    it("rejects a callback with a query string", () => {
        expect(
            linkRequestEnvelopeSchema.safeParse(envelope({ callback: "memberapp://v1/response?src=userapp" })).success
        ).toBe(false)
    })

    it("rejects a callback with a fragment", () => {
        expect(
            linkRequestEnvelopeSchema.safeParse(envelope({ callback: "memberapp://v1/response#section" })).success
        ).toBe(false)
    })
})

describe("linkRequestSchema", () => {
    it("accepts a well-formed request per op", () => {
        for (const { op, params } of opFixtures) {
            const request = {
                id: "req-1",
                version: "v1",
                caller: fixtures.caller,
                callback: fixtures.callback,
                op,
                params
            }
            expect(linkRequestSchema.safeParse(request).success).toBe(true)
        }
    })

    it("rejects an unknown op", () => {
        const request = {
            id: "req-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "future.op",
            params: {}
        }
        expect(linkRequestSchema.safeParse(request).success).toBe(false)
    })

    it("rejects params with a hex field one byte short", () => {
        const request = {
            id: "req-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: {
                ...fixtures.registrationSignParams,
                verifyingContract: fixtures.registrationSignParams.verifyingContract.slice(0, -2)
            }
        }
        expect(linkRequestSchema.safeParse(request).success).toBe(false)
    })

    it("rejects an unlisted extra field on the params object", () => {
        const request = {
            id: "req-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "credential.issue",
            params: { ...fixtures.credentialIssueParams, extra: true }
        }
        expect(linkRequestSchema.safeParse(request).success).toBe(false)
    })

    it("rejects the wrong version", () => {
        const request = {
            id: "req-1",
            version: "v2",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }
        expect(linkRequestSchema.safeParse(request).success).toBe(false)
    })

    it.each(RETIRED_OPS)("rejects a request for the retired %s op", (op) => {
        const request = {
            id: "req-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op,
            params: {}
        }
        expect(linkRequestSchema.safeParse(request).success).toBe(false)
    })
})

describe("linkErrorCodeSchema", () => {
    it("accepts every protocol error code", () => {
        for (const code of [
            "USER_DENIED",
            "CONSENT_DENIED",
            "UNSUPPORTED_OP",
            "INVALID_REQUEST",
            "NOT_ONBOARDED",
            "NO_CREDENTIAL",
            "CREDENTIAL_REVOKED",
            "PROOF_FAILED",
            "ISSUER_UNREACHABLE",
            "VERIFIER_UNREACHABLE",
            "ISSUER_NOT_APPROVED",
            "CHAIN_UNREACHABLE",
            "INTERNAL"
        ]) {
            expect(linkErrorCodeSchema.safeParse(code).success).toBe(true)
        }
    })

    it("rejects a code outside the protocol", () => {
        expect(linkErrorCodeSchema.safeParse("SOMETHING_ELSE").success).toBe(false)
    })
})

describe("linkResponseSchema", () => {
    it("accepts an ok:true response", () => {
        expect(
            linkResponseSchema.safeParse({ id: "1", version: "v1", ok: true, result: { anything: 1 } }).success
        ).toBe(true)
    })

    it("accepts an ok:false response with an optional message", () => {
        expect(
            linkResponseSchema.safeParse({ id: "1", version: "v1", ok: false, code: "USER_DENIED", message: "no" })
                .success
        ).toBe(true)
    })

    it("rejects an ok:false response with a code outside the protocol", () => {
        expect(
            linkResponseSchema.safeParse({ id: "1", version: "v1", ok: false, code: "SOMETHING_ELSE" }).success
        ).toBe(false)
    })

    it("rejects an unlisted extra field", () => {
        expect(
            linkResponseSchema.safeParse({ id: "1", version: "v1", ok: true, result: {}, extra: true }).success
        ).toBe(false)
    })
})
