import { describe, it, expect } from "@jest/globals"
import {
    MAX_URL_LENGTH,
    USER_APP_SCHEME,
    base64UrlDecode,
    base64UrlEncode,
    decodeRequest,
    decodeResponse,
    encodeRequest,
    encodeResponse
} from "../src/codec"
import { LinkDecodeError, LinkError, LinkPayloadTooLargeError } from "../src/errors"
import { DENIED_CALLBACK_SCHEMES } from "../src/schemas"
import type { Caller, LinkOp, LinkRequest, LinkResponse, Params, Result } from "../src/types"
import * as fixtures from "./fixtures"

function encodeJsonPayload(value: unknown): string {
    return base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)))
}

function thrownBy(fn: () => unknown): unknown {
    try {
        fn()
        return undefined
    } catch (error) {
        return error
    }
}

/**
 * Runs both round-trip checks for one op. A plain array of `{ op, params, result }` fixtures
 * doesn't work here: destructuring a loop variable typed as a union of six shapes gives back
 * three independently-unioned fields, not the one correlated triple TS needs to type-check
 * `LinkRequest<Op>`/`LinkResponse<Op>` - so each op gets its own call, with `Op` inferred fresh
 * from that call's own literal argument.
 */
function testRoundTrip<Op extends LinkOp>(op: Op, params: Params<Op>, result: Result<Op>): void {
    it(`round trips a ${op} request`, () => {
        // LinkRequest<Op>/LinkResponse<Op> are distributive conditional types: they don't resolve
        // for an unsubstituted generic Op, so the correlation is asserted rather than inferred here.
        const request = {
            id: "11111111-1111-4111-8111-111111111111",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op,
            params
        } as LinkRequest<Op>

        const url = encodeRequest(request)

        expect(url.startsWith(`${USER_APP_SCHEME}://v1/request?payload=`)).toBe(true)
        expect(decodeRequest(url)).toEqual(request)
    })

    it(`round trips an ok:true ${op} response`, () => {
        const response = { id: "resp-1", version: "v1", ok: true, result } as LinkResponse<Op>

        const url = encodeResponse(fixtures.callback, response)

        expect(url.startsWith(`${fixtures.callback}?payload=`)).toBe(true)
        expect(decodeResponse(url)).toEqual(response)
    })
}

describe("base64UrlEncode / base64UrlDecode", () => {
    it("round trips arbitrary bytes at every padding length, with no +, / or = in the output", () => {
        for (let length = 0; length < 8; length += 1) {
            const bytes = Uint8Array.from({ length }, (_, i) => (i * 37) % 256)
            const encoded = base64UrlEncode(bytes)
            expect(encoded).not.toMatch(/[+/=]/)
            expect(base64UrlDecode(encoded)).toEqual(bytes)
        }
    })
})

describe("round trips per op", () => {
    testRoundTrip("registration.sign", fixtures.registrationSignParams, fixtures.registrationSignResult)
    testRoundTrip("credential.issue", fixtures.credentialIssueParams, fixtures.credentialIssueResult)
    testRoundTrip("presentation.create", fixtures.presentationCreateParams, fixtures.presentationCreateResult)
})

describe("encodeRequest / decodeRequest", () => {
    it("honors a custom scheme", () => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }

        const url = encodeRequest(request, { scheme: "customscheme" })

        expect(url.startsWith("customscheme://v1/request?payload=")).toBe(true)
    })

    it("decodes a request with an op this build doesn't know about instead of throwing", () => {
        // Deciding an op is unsupported is createRequestHandler's job (it can still answer with an
        // UNSUPPORTED_OP response); decodeRequest only needs a usable id and callback to do that.
        const request = {
            id: "id-2",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "future.op",
            params: { anything: true }
        }
        const url = `${USER_APP_SCHEME}://v1/request?payload=${encodeJsonPayload(request)}`

        const decoded = decodeRequest(url)

        expect(decoded.op).toBe("future.op")
        expect(decoded.params).toEqual({ anything: true })
    })

    it("finds payload alongside a valueless query flag", () => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-3",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }
        const url = `${USER_APP_SCHEME}://v1/request?debug&payload=${encodeJsonPayload(request)}`

        expect(decodeRequest(url)).toEqual(request)
    })

    it("throws LinkDecodeError when there is no query string at all", () => {
        expect(() => decodeRequest(`${USER_APP_SCHEME}://v1/request`)).toThrow(LinkDecodeError)
    })

    it("throws LinkDecodeError when the query string has no payload key", () => {
        expect(() => decodeRequest(`${USER_APP_SCHEME}://v1/request?other=1`)).toThrow(LinkDecodeError)
    })

    it("throws LinkDecodeError when the payload is not valid base64url-encoded JSON", () => {
        expect(() => decodeRequest(`${USER_APP_SCHEME}://v1/request?payload=not-valid-json!!!`)).toThrow(
            LinkDecodeError
        )
    })

    it("throws LinkDecodeError when the envelope is missing required fields", () => {
        const url = `${USER_APP_SCHEME}://v1/request?payload=${encodeJsonPayload({ id: "1" })}`

        expect(() => decodeRequest(url)).toThrow(LinkDecodeError)
    })

    it("throws LinkDecodeError for a request carrying the wrong version", () => {
        const url = `${USER_APP_SCHEME}://v1/request?payload=${encodeJsonPayload({
            id: "1",
            version: "v2",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        })}`

        expect(() => decodeRequest(url)).toThrow(LinkDecodeError)
    })
})

describe("callback and scheme reject a query string or fragment", () => {
    // encodeResponse always appends its own `?payload=` to callback; a callback that already has
    // a `?` or `#` would bury or hide that parameter, leaving a member app's client hanging until
    // timeout instead of ever decoding the response - see src/codec.ts's encodeResponse.
    it.each([
        ["a query string", "memberapp://v1/response?src=userapp"],
        ["a fragment", "memberapp://v1/response#section"]
    ])("encodeRequest throws INVALID_REQUEST for a callback with %s", (_label, callback) => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-4",
            version: "v1",
            caller: fixtures.caller,
            callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }

        const error = thrownBy(() => encodeRequest(request))

        expect(error).toBeInstanceOf(LinkError)
        expect((error as LinkError).code).toBe("INVALID_REQUEST")
        // Distinct from the denied-scheme message below, so a caller can tell the two apart.
        expect((error as LinkError).message).toBe("callback must be an absolute URL with no query string or fragment")
    })

    it.each([
        ["a query string", "memberapp://v1/response?src=userapp"],
        ["a fragment", "memberapp://v1/response#section"]
    ])("decodeRequest throws LinkDecodeError for a decoded callback with %s", (_label, callback) => {
        const url = `${USER_APP_SCHEME}://v1/request?payload=${encodeJsonPayload({
            id: "id-5",
            version: "v1",
            caller: fixtures.caller,
            callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        })}`

        expect(() => decodeRequest(url)).toThrow(LinkDecodeError)
    })

    it.each([
        ["a query string", "customscheme?debug"],
        ["a fragment", "customscheme#debug"]
    ])("encodeRequest throws INVALID_REQUEST for a scheme with %s", (_label, scheme) => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-6",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }

        const error = thrownBy(() => encodeRequest(request, { scheme }))

        expect(error).toBeInstanceOf(LinkError)
        expect((error as LinkError).code).toBe("INVALID_REQUEST")
    })
})

describe("callback and scheme reject a denied scheme", () => {
    // A response must stay on-device in a custom app scheme: http(s) would let it leave the
    // device, and Android resolves intent/file/content/javascript/data to more than opening
    // another app - see DENIED_CALLBACK_SCHEMES in src/schemas.ts.
    it.each(DENIED_CALLBACK_SCHEMES)("encodeRequest throws INVALID_REQUEST for a %s callback", (scheme) => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-7",
            version: "v1",
            caller: fixtures.caller,
            callback: `${scheme}://blocked`,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }

        const error = thrownBy(() => encodeRequest(request))

        expect(error).toBeInstanceOf(LinkError)
        expect((error as LinkError).code).toBe("INVALID_REQUEST")
        // Distinct from the query-string/fragment message above, not the generic message it used
        // to share with it.
        expect((error as LinkError).message).toBe(
            `callback scheme must not be one of: ${DENIED_CALLBACK_SCHEMES.join(", ")}`
        )
    })

    it.each(DENIED_CALLBACK_SCHEMES)("decodeRequest throws LinkDecodeError for a decoded %s callback", (scheme) => {
        const url = `${USER_APP_SCHEME}://v1/request?payload=${encodeJsonPayload({
            id: "id-8",
            version: "v1",
            caller: fixtures.caller,
            callback: `${scheme}://blocked`,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        })}`

        expect(() => decodeRequest(url)).toThrow(LinkDecodeError)
    })

    it.each(DENIED_CALLBACK_SCHEMES)("encodeRequest throws INVALID_REQUEST for a %s request scheme", (scheme) => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-9",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }

        const error = thrownBy(() => encodeRequest(request, { scheme }))

        expect(error).toBeInstanceOf(LinkError)
        expect((error as LinkError).code).toBe("INVALID_REQUEST")
    })

    it("round trips a request and response through an accepted custom scheme", () => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-10",
            version: "v1",
            caller: fixtures.caller,
            callback: "memberapp://v1/response",
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }

        const url = encodeRequest(request, { scheme: "memberapp" })

        expect(url.startsWith("memberapp://v1/request?payload=")).toBe(true)
        expect(decodeRequest(url)).toEqual(request)
    })
})

describe("encodeRequest rejects a caller decodeRequest would refuse", () => {
    // callerSchema (src/schemas.ts) caps name at 64 characters; without this check a longer name
    // makes it past encodeRequest but decodeRequest can never accept the resulting URL, so the
    // member app just waits out its own timeout instead of getting INVALID_REQUEST back.
    it("throws INVALID_REQUEST for a caller name over 64 characters", () => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-11",
            version: "v1",
            caller: { name: "x".repeat(65), scheme: fixtures.caller.scheme },
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }

        const error = thrownBy(() => encodeRequest(request))

        expect(error).toBeInstanceOf(LinkError)
        expect((error as LinkError).code).toBe("INVALID_REQUEST")
        expect((error as LinkError).message).toMatch(/^caller /)
    })

    it("accepts a caller name of exactly 64 characters", () => {
        const request: LinkRequest<"registration.sign"> = {
            id: "id-12",
            version: "v1",
            caller: { name: "x".repeat(64), scheme: fixtures.caller.scheme },
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }

        expect(() => encodeRequest(request)).not.toThrow()
    })
})

describe("encodeResponse / decodeResponse", () => {
    it("round trips an ok:false response", () => {
        const response: LinkResponse = {
            id: "resp-2",
            version: "v1",
            ok: false,
            code: "USER_DENIED",
            message: "no thanks"
        }

        const url = encodeResponse(fixtures.callback, response)

        expect(decodeResponse(url)).toEqual(response)
    })

    it("throws LinkDecodeError when the payload query parameter is missing", () => {
        expect(() => decodeResponse(fixtures.callback)).toThrow(LinkDecodeError)
    })

    it("throws LinkDecodeError for a response missing ok", () => {
        const url = `${fixtures.callback}?payload=${encodeJsonPayload({ id: "1", version: "v1" })}`

        expect(() => decodeResponse(url)).toThrow(LinkDecodeError)
    })
})

describe("MAX_URL_LENGTH", () => {
    it("throws LinkPayloadTooLargeError encoding a credential.issue request whose URLs are 3000 bytes", () => {
        const request: LinkRequest<"credential.issue"> = {
            id: "big-request",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            params: { ...fixtures.credentialIssueParams, credentialsUrl: `https://issuer.example/${"a".repeat(3000)}` },
            op: "credential.issue"
        }

        expect(() => encodeRequest(request)).toThrow(LinkPayloadTooLargeError)
    })

    it("throws LinkPayloadTooLargeError encoding a credential.issue response 3000 bytes over the limit", () => {
        const response: LinkResponse<"credential.issue"> = {
            id: "big-response",
            version: "v1",
            ok: true,
            result: { status: "stored", credentialId: "c".repeat(MAX_URL_LENGTH + 3000) }
        }

        expect(() => encodeResponse(fixtures.callback, response)).toThrow(LinkPayloadTooLargeError)
    })

    it("passes at exactly MAX_URL_LENGTH and throws one character over", () => {
        // The scheme is plain text in the URL, not base64 - unlike padding the payload, growing it
        // by one character grows the final URL by exactly one character, so the boundary lands
        // precisely instead of jumping over it in a base64 group's 1-3 byte step.
        const request: LinkRequest<"registration.sign"> = {
            id: "boundary",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: fixtures.registrationSignParams
        }
        const urlFor = (schemeLength: number) => encodeRequest(request, { scheme: "s".repeat(schemeLength) })

        const base = urlFor(1)
        expect(base.length).toBeLessThan(MAX_URL_LENGTH)
        const neededSchemeLength = 1 + (MAX_URL_LENGTH - base.length)

        const atLimit = urlFor(neededSchemeLength)
        expect(atLimit).toHaveLength(MAX_URL_LENGTH)

        expect(() => urlFor(neededSchemeLength + 1)).toThrow(LinkPayloadTooLargeError)
    })
})

describe("worst-case realistic payloads against MAX_URL_LENGTH", () => {
    // Nothing else exercises the real codec end to end - the app tests use a fake link client - so
    // without these, an overflow would first be seen as a LinkPayloadTooLargeError thrown midway
    // through a flow on a device. The credential itself no longer crosses the link (the wallet
    // fetches it), which is what left these two so far inside the budget.
    const caller: Caller = { name: "N".repeat(64), scheme: "member-a" } // the schema's maximum
    const callback = "member-a://v1/response"
    const serverUrl = "http://192.168.100.100:4001"

    function headroom(url: string): number {
        return MAX_URL_LENGTH - url.length
    }

    it("encodes a full-width credential.issue request with room to spare", () => {
        const url = encodeRequest<"credential.issue">({
            id: "urn:uuid:00000000-0000-4000-8000-000000000000",
            version: "v1",
            caller,
            callback,
            op: "credential.issue",
            params: {
                issuerNetworkId: `0x${"a1".repeat(32)}`,
                approvalScope: { programme: "P".repeat(64), country: "ZZZ" },
                challengeUrl: `${serverUrl}/v1/challenge`,
                credentialsUrl: `${serverUrl}/v1/credentials`,
                issuersUrl: `${serverUrl}/v1/issuers`,
                revocationsUrl: `${serverUrl}/v1/revocations/snapshot`
            }
        })

        expect(headroom(url)).toBeGreaterThan(0)
    })

    it("encodes a full-width registration.sign response with room to spare", () => {
        const url = encodeResponse<"registration.sign">(callback, {
            id: "urn:uuid:00000000-0000-4000-8000-000000000000",
            version: "v1",
            ok: true,
            result: {
                request: {
                    version: "v1",
                    networkId: `0x${"a1".repeat(32)}`,
                    schemeId: 1,
                    metaStealthAddress: `0x${"b2".repeat(66)}`,
                    chainId: 31_337,
                    verifyingContract: `0x${"c3".repeat(20)}`,
                    signature: `0x${"d4".repeat(65)}`
                },
                securityLevel: "TRUSTED_ENVIRONMENT"
            }
        })

        expect(headroom(url)).toBeGreaterThan(0)
    })
})

describe("WS1 same-device presentation payload", () => {
    it("fits a Sepolia reference-app challenge and verdict into deep links without carrying the proof", () => {
        const id = "11111111-1111-4111-8111-111111111111"
        const origin = "https://member.reference.example"
        const request: LinkRequest<"presentation.create"> = {
            id,
            version: "v1",
            caller: { name: "Reference Network Member", scheme: "memberapp" },
            callback: fixtures.callback,
            op: "presentation.create",
            params: {
                ...fixtures.presentationCreateParams,
                requestId: `urn:uuid:${id}`,
                audience: `0x${"ab".repeat(32)}`,
                issuersUrl: `${origin}/v1/issuers`,
                revocationsUrl: `${origin}/v1/revocations/snapshot`,
                responseUrl: `${origin}/v1/verify`
            }
        }
        const requestUrl = encodeRequest(request)
        const response: LinkResponse<"presentation.create"> = {
            id,
            version: "v1",
            ok: true,
            result: { verificationId: `urn:uuid:${id}` }
        }
        const responseUrl = encodeResponse(fixtures.callback, response)
        expect(requestUrl.length).toBeLessThanOrEqual(MAX_URL_LENGTH)
        expect(responseUrl.length).toBeLessThanOrEqual(MAX_URL_LENGTH)
        expect(decodeRequest(requestUrl)).toEqual(request)
        expect(decodeResponse(responseUrl)).toEqual(response)
        expect(Object.keys(decodeResponse(responseUrl))).not.toContain("proof")

        // A programme name is user-provided configuration, not a fixed-size cryptographic field.
        // Oversized requests must fail before opening the wallet rather than being truncated.
        expect(() =>
            encodeRequest({
                ...request,
                params: { ...request.params, programme: "x".repeat(MAX_URL_LENGTH) }
            })
        ).toThrow(LinkPayloadTooLargeError)
    })
})
