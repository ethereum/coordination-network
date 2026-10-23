import { describe, it, expect, jest } from "@jest/globals"
import { USER_APP_SCHEME, base64UrlEncode, decodeResponse, encodeRequest } from "../src/codec"
import { LinkDecodeError, LinkError } from "../src/errors"
import { createRequestHandler } from "../src/handler"
import { LINK_ERROR_MESSAGES } from "../src/messages"
import { LINK_ERROR_CODES } from "../src/types"
import type { CredentialIssueResult, LinkHandlers, LinkOp, LinkRequest, Params } from "../src/types"
import * as fixtures from "./fixtures"

function requestUrl<Op extends LinkOp>(op: Op, params: Params<Op>): string {
    // See codec.test.ts's testRoundTrip comment: LinkRequest<Op> doesn't resolve for an
    // unsubstituted generic Op, so the correlation is asserted rather than inferred here.
    const request = {
        id: "req-1",
        version: "v1",
        caller: fixtures.caller,
        callback: fixtures.callback,
        op,
        params
    } as LinkRequest<Op>
    return encodeRequest(request)
}

/** Builds a request URL that bypasses LinkRequest's typing, for payloads that are deliberately malformed. */
function rawRequestUrl(payload: Record<string, unknown>): string {
    const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)))
    return `${USER_APP_SCHEME}://v1/request?payload=${encoded}`
}

const alwaysConsent = async () => true

describe("createRequestHandler", () => {
    it("dispatches to the matching handler and encodes an ok:true response", async () => {
        const registrationSignHandler = jest.fn(async () => fixtures.registrationSignResult)
        const handlers: LinkHandlers = { "registration.sign": registrationSignHandler }
        const handler = createRequestHandler({ handlers, consent: alwaysConsent })

        const response = decodeResponse(
            await handler.handle(requestUrl("registration.sign", fixtures.registrationSignParams))
        )

        expect(response).toEqual({ id: "req-1", version: "v1", ok: true, result: fixtures.registrationSignResult })
        expect(registrationSignHandler).toHaveBeenCalledWith(fixtures.registrationSignParams, {
            caller: fixtures.caller
        })
    })

    it("responds UNSUPPORTED_OP for a known op with no registered handler", async () => {
        const handler = createRequestHandler({ handlers: {}, consent: alwaysConsent })

        const response = decodeResponse(
            await handler.handle(requestUrl("registration.sign", fixtures.registrationSignParams))
        )

        expect(response).toMatchObject({
            ok: false,
            code: "UNSUPPORTED_OP",
            message: LINK_ERROR_MESSAGES.UNSUPPORTED_OP
        })
    })

    it("responds UNSUPPORTED_OP for an op outside the protocol", async () => {
        const handler = createRequestHandler({ handlers: {}, consent: alwaysConsent })
        const url = rawRequestUrl({
            id: "req-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "future.op",
            params: {}
        })

        const response = decodeResponse(await handler.handle(url))

        expect(response).toMatchObject({ ok: false, code: "UNSUPPORTED_OP" })
    })

    it("responds INVALID_REQUEST when params fail the op's schema, without dispatching", async () => {
        const registrationSignHandler = jest.fn(async () => fixtures.registrationSignResult)
        const handlers: LinkHandlers = { "registration.sign": registrationSignHandler }
        const handler = createRequestHandler({ handlers, consent: alwaysConsent })
        const url = rawRequestUrl({
            id: "req-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: { chainId: 1, verifyingContract: "0xbad" }
        })

        const response = decodeResponse(await handler.handle(url))

        expect(response).toMatchObject({ ok: false, code: "INVALID_REQUEST" })
        expect((response as { message?: string }).message).not.toBe(LINK_ERROR_MESSAGES.INVALID_REQUEST)
        expect(registrationSignHandler).not.toHaveBeenCalled()
    })

    it("responds USER_DENIED when consent is refused, without dispatching", async () => {
        const registrationSignHandler = jest.fn(async () => fixtures.registrationSignResult)
        const handlers: LinkHandlers = { "registration.sign": registrationSignHandler }
        const handler = createRequestHandler({ handlers, consent: async () => false })

        const response = decodeResponse(
            await handler.handle(requestUrl("registration.sign", fixtures.registrationSignParams))
        )

        expect(response).toMatchObject({
            ok: false,
            code: "USER_DENIED",
            message: LINK_ERROR_MESSAGES.USER_DENIED
        })
        expect(registrationSignHandler).not.toHaveBeenCalled()
    })

    it("shows consent the decoded request before dispatching", async () => {
        const consent = jest.fn(async () => true)
        const handlers: LinkHandlers = { "credential.issue": jest.fn(async () => fixtures.credentialIssueResult) }
        const handler = createRequestHandler({ handlers, consent })

        await handler.handle(requestUrl("credential.issue", fixtures.credentialIssueParams))

        expect(consent).toHaveBeenCalledWith(
            expect.objectContaining({ op: "credential.issue", params: fixtures.credentialIssueParams })
        )
    })

    it("has a fixed message for every error code", () => {
        expect(Object.keys(LINK_ERROR_MESSAGES).sort()).toEqual([...LINK_ERROR_CODES].sort())
    })

    it("responds with a thrown LinkError's code and the fixed message, not its own text", async () => {
        const handlers: LinkHandlers = {
            "credential.issue": jest.fn(async () => {
                throw new LinkError("VERIFIER_UNREACHABLE", "issuer server is down")
            })
        }
        const handler = createRequestHandler({ handlers, consent: alwaysConsent })

        const url = await handler.handle(requestUrl("credential.issue", fixtures.credentialIssueParams))
        const response = decodeResponse(url)

        expect(response).toMatchObject({
            ok: false,
            code: "VERIFIER_UNREACHABLE",
            message: LINK_ERROR_MESSAGES.VERIFIER_UNREACHABLE
        })
        expect(JSON.stringify(response)).not.toContain("issuer server is down")
    })

    it("never sends any of a long LinkError message, however detailed", async () => {
        const detail = `https://rpc.example/v2/secret-key ${"x".repeat(3000)}`
        const handlers: LinkHandlers = {
            "credential.issue": jest.fn(async () => {
                throw new LinkError("CHAIN_UNREACHABLE", detail)
            })
        }
        const handler = createRequestHandler({ handlers, consent: alwaysConsent })

        const response = decodeResponse(
            await handler.handle(requestUrl("credential.issue", fixtures.credentialIssueParams))
        )

        expect(response).toMatchObject({
            ok: false,
            code: "CHAIN_UNREACHABLE",
            message: LINK_ERROR_MESSAGES.CHAIN_UNREACHABLE
        })
        expect(JSON.stringify(response)).not.toContain("secret-key")
    })

    it("responds INTERNAL without leaking a thrown non-LinkError's message", async () => {
        const handlers: LinkHandlers = {
            "credential.issue": jest.fn(async () => {
                throw new Error("stack trace with a local file path in it")
            })
        }
        const handler = createRequestHandler({ handlers, consent: alwaysConsent })

        const response = decodeResponse(
            await handler.handle(requestUrl("credential.issue", fixtures.credentialIssueParams))
        )

        expect(response).toMatchObject({ ok: false, code: "INTERNAL", message: LINK_ERROR_MESSAGES.INTERNAL })
        expect(JSON.stringify(response)).not.toContain("stack trace")
    })

    it("responds INTERNAL without leaking the zod message when a handler's result fails its own schema", async () => {
        // Deliberately the wrong shape (no such status) to exercise the runtime check that catches
        // a buggy handler - TS wouldn't allow this without the cast.
        const badResult = { status: "not-a-status" } as unknown as CredentialIssueResult
        const handlers: LinkHandlers = { "credential.issue": jest.fn(async () => badResult) }
        const handler = createRequestHandler({ handlers, consent: alwaysConsent })

        const response = decodeResponse(
            await handler.handle(requestUrl("credential.issue", fixtures.credentialIssueParams))
        )

        expect(response).toEqual({
            id: "req-1",
            version: "v1",
            ok: false,
            code: "INTERNAL",
            message: LINK_ERROR_MESSAGES.INTERNAL
        })
        expect(JSON.stringify(response)).not.toContain("not-a-status")
    })

    it("responds INVALID_REQUEST instead of throwing when the schema error message is oversized", async () => {
        const handlers: LinkHandlers = { "registration.sign": jest.fn(async () => fixtures.registrationSignResult) }
        const handler = createRequestHandler({ handlers, consent: alwaysConsent })
        // Every params schema is strict, so one absurdly long unrecognized key makes zod's own
        // error message long enough to blow encodeResponse's URL budget on its own.
        const oversizedKey = "x".repeat(3000)
        const url = rawRequestUrl({
            id: "req-1",
            version: "v1",
            caller: fixtures.caller,
            callback: fixtures.callback,
            op: "registration.sign",
            params: { [oversizedKey]: "present" }
        })

        const response = decodeResponse(await handler.handle(url))

        expect(response).toMatchObject({ ok: false, code: "INVALID_REQUEST" })
        expect((response as { message?: string }).message?.length ?? 0).toBeLessThanOrEqual(256)
    })

    it("throws LinkDecodeError for an undecodable URL rather than responding", async () => {
        const handler = createRequestHandler({ handlers: {}, consent: alwaysConsent })

        await expect(handler.handle(`${USER_APP_SCHEME}://v1/request`)).rejects.toThrow(LinkDecodeError)
    })
})
