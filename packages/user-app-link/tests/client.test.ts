import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals"
import { base64UrlEncode, decodeRequest, encodeResponse } from "../src/codec"
import { LinkError } from "../src/errors"
import { createLinkClient, type LinkClientOptions } from "../src/client"
import type { CredentialIssueResult } from "../src/types"
import * as fixtures from "./fixtures"

function createHarness(overrides: Partial<LinkClientOptions> = {}) {
    let listener: ((url: string) => void) | null = null
    const opened: string[] = []
    const unsubscribe = jest.fn()
    const { openUrl: openUrlOverride, ...rest } = overrides

    const client = createLinkClient({
        caller: fixtures.caller,
        callback: fixtures.callback,
        // opened always records the URL, even when a test's openUrl override throws, so
        // lastRequest() stays usable for requests made after an earlier one failed to open.
        openUrl: async (url: string) => {
            opened.push(url)
            if (openUrlOverride) {
                await openUrlOverride(url)
            }
        },
        onUrl: (nextListener: (url: string) => void) => {
            listener = nextListener
            return unsubscribe
        },
        ...rest
    })

    return {
        client,
        unsubscribe,
        deliver: (url: string) => listener?.(url),
        // The Promise executor in createLinkClient runs synchronously, so by the time `request`
        // returns, onUrl/openUrl have already run and the encoded request is available here.
        lastRequest: () => decodeRequest(opened[opened.length - 1])
    }
}

describe("createLinkClient", () => {
    it("resolves with the result from a matching ok:true response", async () => {
        const harness = createHarness()
        const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)
        const request = harness.lastRequest()

        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: true,
                result: fixtures.registrationSignResult
            })
        )

        await expect(promise).resolves.toEqual(fixtures.registrationSignResult)
        expect(harness.unsubscribe).toHaveBeenCalledTimes(1)
    })

    it("ignores a redelivered response once the request has already settled", async () => {
        const harness = createHarness()
        const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)
        const request = harness.lastRequest()
        const response = encodeResponse(fixtures.callback, {
            id: request.id,
            version: "v1",
            ok: true,
            result: fixtures.registrationSignResult
        })

        harness.deliver(response)
        await expect(promise).resolves.toEqual(fixtures.registrationSignResult)

        // The harness's unsubscribe is a stub, so redelivery is still possible here even though a
        // real Linking listener would have already been detached.
        expect(() => harness.deliver(response)).not.toThrow()
    })

    it("ignores a second, distinct response for the same id once the first has already settled it", async () => {
        const harness = createHarness()
        const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)
        const request = harness.lastRequest()

        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: true,
                result: fixtures.registrationSignResult
            })
        )
        // A different result for the same id: if the second delivery weren't ignored, this would
        // either override the settled value or blow up on an already-called unsubscribe.
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: false,
                code: "USER_DENIED"
            })
        )

        await expect(promise).resolves.toEqual(fixtures.registrationSignResult)
        expect(harness.unsubscribe).toHaveBeenCalledTimes(1)
    })

    it("ignores a response whose id matches but which otherwise fails the response schema", async () => {
        const harness = createHarness()
        const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)
        const request = harness.lastRequest()

        // Same id, ok:true branch, but the wrong version literal: linkResponseSchema fails the
        // whole envelope, so decodeResponse throws before handleUrl can even compare the id.
        harness.deliver(
            `${fixtures.callback}?payload=${base64UrlEncode(
                new TextEncoder().encode(
                    JSON.stringify({ id: request.id, version: "v2", ok: true, result: fixtures.registrationSignResult })
                )
            )}`
        )
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: true,
                result: fixtures.registrationSignResult
            })
        )

        await expect(promise).resolves.toEqual(fixtures.registrationSignResult)
    })

    it("rejects with LinkError INTERNAL when the id matches but the response's result fails its op's result schema", async () => {
        const harness = createHarness()
        const promise = harness.client.request("credential.issue", fixtures.credentialIssueParams)
        const request = harness.lastRequest()
        // Deliberately the wrong shape (no such status) to exercise the client-side check
        // that catches a buggy responder - TS wouldn't allow this without the cast.
        const badResult = { status: "not-a-status" } as unknown as CredentialIssueResult

        harness.deliver(
            encodeResponse(fixtures.callback, { id: request.id, version: "v1", ok: true, result: badResult })
        )

        await expect(promise).rejects.toBeInstanceOf(LinkError)
        await expect(promise).rejects.toMatchObject({ code: "INTERNAL" })
    })

    it("unlike an envelope failure, a result-schema failure settles the request rather than leaving it pending", async () => {
        const harness = createHarness()
        const promise = harness.client.request("credential.issue", fixtures.credentialIssueParams)
        const request = harness.lastRequest()
        const badResult = { status: "not-a-status" } as unknown as CredentialIssueResult

        harness.deliver(
            encodeResponse(fixtures.callback, { id: request.id, version: "v1", ok: true, result: badResult })
        )
        await expect(promise).rejects.toMatchObject({ code: "INTERNAL" })
        expect(harness.unsubscribe).toHaveBeenCalledTimes(1)

        // The failed request must have cleared `pending`, or this second call would reject with
        // "already in flight" instead of proceeding normally - it must not hang until timeout either.
        const second = harness.client.request("registration.sign", fixtures.registrationSignParams)
        const secondRequest = harness.lastRequest()
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: secondRequest.id,
                version: "v1",
                ok: true,
                result: fixtures.registrationSignResult
            })
        )
        await expect(second).resolves.toEqual(fixtures.registrationSignResult)
    })

    it("rejects with a LinkError carrying the response's code and message on ok:false", async () => {
        const harness = createHarness()
        const promise = harness.client.request("credential.issue", fixtures.credentialIssueParams)
        const request = harness.lastRequest()

        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: false,
                code: "NOT_ONBOARDED",
                message: "please onboard first"
            })
        )

        await expect(promise).rejects.toBeInstanceOf(LinkError)
        await expect(promise).rejects.toMatchObject({ code: "NOT_ONBOARDED", message: "please onboard first" })
    })

    it("ignores a URL it can't decode as a response", async () => {
        const harness = createHarness()
        const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)
        const request = harness.lastRequest()

        harness.deliver("someotherapp://not-a-response-at-all")
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: true,
                result: fixtures.registrationSignResult
            })
        )

        await expect(promise).resolves.toEqual(fixtures.registrationSignResult)
    })

    it("ignores a response for a different request id", async () => {
        const harness = createHarness()
        const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)
        const request = harness.lastRequest()

        // Not the id this client is waiting on, and carrying a different result shape: if id
        // matching were broken, the promise below would settle on this result instead of the
        // real one delivered next.
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: "some-other-requests-id",
                version: "v1",
                ok: true,
                result: fixtures.credentialIssueResult
            })
        )
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: true,
                result: fixtures.registrationSignResult
            })
        )

        await expect(promise).resolves.toEqual(fixtures.registrationSignResult)
    })

    it("rejects a second request while one is already in flight, without disturbing the first", async () => {
        const harness = createHarness()
        const first = harness.client.request("registration.sign", fixtures.registrationSignParams)

        await expect(harness.client.request("registration.sign", fixtures.registrationSignParams)).rejects.toThrow(
            /already in flight/
        )

        const request = harness.lastRequest()
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: true,
                result: fixtures.registrationSignResult
            })
        )
        await expect(first).resolves.toEqual(fixtures.registrationSignResult)
    })

    it("rejects with LinkError INVALID_REQUEST rather than throwing when the callback fails its own schema", async () => {
        const harness = createHarness({ callback: "memberapp://v1/response?src=userapp" })

        const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)

        await expect(promise).rejects.toBeInstanceOf(LinkError)
        await expect(promise).rejects.toMatchObject({ code: "INVALID_REQUEST" })
    })

    it("rejects rather than throwing when a caller-supplied randomId throws", async () => {
        const harness = createHarness({
            randomId: () => {
                throw new Error("randomId exploded")
            }
        })

        await expect(harness.client.request("registration.sign", fixtures.registrationSignParams)).rejects.toThrow(
            "randomId exploded"
        )
    })

    it("rejects when openUrl itself fails, and allows a new request afterward", async () => {
        const openUrlError = new Error("no app registered for this scheme")
        let calls = 0
        // Only the first call fails, so the "second" request below can open normally.
        // Throwing (rather than returning Promise.reject(...)) keeps the rejection inside the
        // async function's own promise instead of momentarily on a separate, unobserved one.
        const harness = createHarness({
            openUrl: async () => {
                calls += 1
                if (calls === 1) {
                    throw openUrlError
                }
            }
        })

        await expect(harness.client.request("registration.sign", fixtures.registrationSignParams)).rejects.toBe(
            openUrlError
        )

        // The failed request must have cleared `pending`, or this second call would also reject.
        const second = harness.client.request("credential.issue", fixtures.credentialIssueParams)
        const request = harness.lastRequest()
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: true,
                result: fixtures.credentialIssueResult
            })
        )
        await expect(second).resolves.toEqual(fixtures.credentialIssueResult)
    })

    describe("timeout", () => {
        beforeEach(() => {
            jest.useFakeTimers()
        })

        afterEach(() => {
            jest.useRealTimers()
        })

        it("rejects after timeoutMs when no response arrives", async () => {
            const harness = createHarness({ timeoutMs: 1000 })
            const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)

            jest.advanceTimersByTime(1000)

            await expect(promise).rejects.toThrow(/timed out/)
            expect(harness.unsubscribe).toHaveBeenCalledTimes(1)
        })

        it("does not time out once a response has already settled the request", async () => {
            const harness = createHarness({ timeoutMs: 1000 })
            const promise = harness.client.request("registration.sign", fixtures.registrationSignParams)
            const request = harness.lastRequest()

            harness.deliver(
                encodeResponse(fixtures.callback, {
                    id: request.id,
                    version: "v1",
                    ok: true,
                    result: fixtures.registrationSignResult
                })
            )
            jest.advanceTimersByTime(1000)

            await expect(promise).resolves.toEqual(fixtures.registrationSignResult)
        })
    })

    // Delivers a matching response so the harness's pending request settles and its timeout timer
    // is cleared - otherwise it's a real (unmocked) 120s timer outliving the test.
    function settle(harness: ReturnType<typeof createHarness>): void {
        const request = harness.lastRequest()
        harness.deliver(
            encodeResponse(fixtures.callback, {
                id: request.id,
                version: "v1",
                ok: true,
                result: fixtures.registrationSignResult
            })
        )
    }

    describe("default id generation", () => {
        it("uses crypto.randomUUID when it's available", async () => {
            const harness = createHarness()

            const pending = harness.client.request("registration.sign", fixtures.registrationSignParams)
            expect(harness.lastRequest().id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

            settle(harness)
            await pending
        })

        it("builds a v4 uuid from crypto.getRandomValues when randomUUID is unavailable", async () => {
            const originalCrypto = globalThis.crypto
            Object.defineProperty(globalThis, "crypto", {
                value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
                configurable: true
            })

            try {
                const harness = createHarness()
                const pending = harness.client.request("registration.sign", fixtures.registrationSignParams)

                expect(harness.lastRequest().id).toMatch(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
                )

                settle(harness)
                await pending
            } finally {
                Object.defineProperty(globalThis, "crypto", { value: originalCrypto, configurable: true })
            }
        })
    })

    it("honors a custom randomId generator", async () => {
        const harness = createHarness({ randomId: () => "deterministic-id" })

        const pending = harness.client.request("registration.sign", fixtures.registrationSignParams)
        expect(harness.lastRequest().id).toBe("deterministic-id")

        settle(harness)
        await pending
    })
})
