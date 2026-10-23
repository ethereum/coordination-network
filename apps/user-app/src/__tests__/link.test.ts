import { encodeRequest, decodeResponse, type Caller, type LinkHandlers } from "@coordination-network/user-app-link"

type UrlListener = (event: { url: string }) => void

// expo-linking's real module talks to native `Linking`; the test drives its listener directly.
// jest.mock's factory may only reference variables prefixed `mock` — hence the naming here.
let mockUrlListener: UrlListener | null = null
const mockOpenUrl = jest.fn<Promise<true>, [string]>(async () => true)
const mockRemove = jest.fn()

jest.mock("expo-linking", () => ({
    addEventListener: (_type: "url", listener: UrlListener) => {
        mockUrlListener = listener
        return { remove: mockRemove }
    },
    getInitialURL: jest.fn(async () => null),
    openURL: (url: string) => mockOpenUrl(url)
}))

import { createLinkSubscription, resetInitialUrlForTests } from "../link"
import * as Linking from "expo-linking"

const caller: Caller = { name: "Member App", scheme: "member-a" }

/** A well-formed `registration.sign` result — every field must pass its schema for `handle` to respond `ok: true`. */
const signed = {
    request: {
        version: "v1" as const,
        networkId: `0x${"aa".repeat(32)}` as const,
        schemeId: 1 as const,
        metaStealthAddress: `0x${"bb".repeat(66)}` as const,
        chainId: 31_337,
        verifyingContract: `0x${"cc".repeat(20)}` as const,
        signature: `0x${"dd".repeat(65)}` as const
    },
    securityLevel: "SOFTWARE" as const
}

const registrationParams = { chainId: 31_337, verifyingContract: `0x${"cc".repeat(20)}` as const }

function requestUrl(overrides: Partial<Parameters<typeof encodeRequest>[0]> = {}) {
    return encodeRequest({
        id: "req-1",
        version: "v1",
        caller,
        callback: "member-a://v1/response",
        op: "registration.sign",
        params: registrationParams,
        ...overrides
    } as Parameters<typeof encodeRequest>[0])
}

function fireUrl(url: string): void {
    mockUrlListener?.({ url })
}

/** Waits for the microtask queue the subscription's internal promise chain runs on to drain. */
async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
    mockUrlListener = null
    mockOpenUrl.mockClear()
    mockRemove.mockClear()
})

describe("createLinkSubscription", () => {
    it("round-trips a request into a response opened at the caller's callback", async () => {
        const handlers: LinkHandlers = { "registration.sign": async () => signed }

        createLinkSubscription({ handlers, consent: async () => true })
        fireUrl(requestUrl())
        await flush()

        expect(mockOpenUrl).toHaveBeenCalledTimes(1)
        const response = decodeResponse(mockOpenUrl.mock.calls[0][0])
        expect(response).toMatchObject({
            id: "req-1",
            ok: true,
            result: { request: { networkId: signed.request.networkId } }
        })
    })

    it("responds with USER_DENIED when consent is refused", async () => {
        const handlers: LinkHandlers = {
            "registration.sign": async () => {
                throw new Error("should not run")
            }
        }

        createLinkSubscription({ handlers, consent: async () => false })
        fireUrl(requestUrl())
        await flush()

        const response = decodeResponse(mockOpenUrl.mock.calls[0][0])
        expect(response).toMatchObject({ ok: false, code: "USER_DENIED" })
    })

    it("serializes a second request behind a first one still awaiting consent", async () => {
        const order: string[] = []
        const firstConsent: { release: (() => void) | null } = { release: null }

        const handlers: LinkHandlers = {
            "registration.sign": async () => {
                order.push("handled")
                return signed
            }
        }

        let consentCalls = 0
        createLinkSubscription({
            handlers,
            consent: async () => {
                consentCalls += 1
                order.push(`consent-${consentCalls}`)
                if (consentCalls === 1) {
                    await new Promise<void>((resolve) => {
                        firstConsent.release = resolve
                    })
                }
                return true
            }
        })

        fireUrl(requestUrl({ id: "req-1" } as never))
        await flush()
        fireUrl(requestUrl({ id: "req-2" } as never))
        await flush()

        // the second request's consent prompt must not appear while the first is still pending
        expect(order).toEqual(["consent-1"])

        firstConsent.release?.()
        await flush()
        await flush()

        expect(order).toEqual(["consent-1", "handled", "consent-2", "handled"])
    })

    it("drops a queued URL once the subscription has been removed", async () => {
        const handlers: LinkHandlers = { "registration.sign": async () => signed }

        const subscription = createLinkSubscription({ handlers, consent: async () => true })
        fireUrl(requestUrl())
        subscription.remove()
        await flush()

        expect(mockOpenUrl).not.toHaveBeenCalled()
    })

    it("reports the op as working once consent approves, then null once the response opens", async () => {
        const handlers: LinkHandlers = { "registration.sign": async () => signed }
        const onWorking = jest.fn()

        createLinkSubscription({ handlers, consent: async () => true, onWorking })
        fireUrl(requestUrl())
        await flush()

        expect(onWorking.mock.calls).toEqual([["registration.sign"], [null]])
    })

    it("reports only null, never an op, when consent denies", async () => {
        const handlers: LinkHandlers = {
            "registration.sign": async () => {
                throw new Error("should not run")
            }
        }
        const onWorking = jest.fn()

        createLinkSubscription({ handlers, consent: async () => false, onWorking })
        fireUrl(requestUrl())
        await flush()

        expect(onWorking).toHaveBeenCalledTimes(1)
        expect(onWorking).toHaveBeenCalledWith(null)
    })

    it("reports null even when opening the response URL fails", async () => {
        const handlers: LinkHandlers = { "registration.sign": async () => signed }
        const onWorking = jest.fn()
        mockOpenUrl.mockRejectedValueOnce(new Error("cannot open callback scheme"))

        createLinkSubscription({ handlers, consent: async () => true, onWorking })
        fireUrl(requestUrl())
        await flush()

        expect(onWorking.mock.calls).toEqual([["registration.sign"], [null]])
    })

    it("reports only null, never opening a URL, when the handler itself throws before there is a callback to answer", async () => {
        const handlers: LinkHandlers = { "registration.sign": async () => signed }
        const onWorking = jest.fn()

        // No payload query parameter at all: decodeRequest throws LinkDecodeError before request.id
        // or request.callback are known, so there is nothing handler.handle can respond to.
        createLinkSubscription({ handlers, consent: async () => true, onWorking })
        fireUrl("userapp://v1/request")
        await flush()

        expect(mockOpenUrl).not.toHaveBeenCalled()
        expect(onWorking).toHaveBeenCalledTimes(1)
        expect(onWorking).toHaveBeenCalledWith(null)
    })

    it("answers the launch URL once, however many subscriptions are built", async () => {
        // getInitialURL keeps returning the URL that started the app, so a subscription rebuilt
        // after an erase (or double-mounted in development) would otherwise answer it twice.
        resetInitialUrlForTests()
        const handlers: LinkHandlers = { "registration.sign": async () => signed }
        const launchUrl = requestUrl()
        // Not `Once`: the real getInitialURL answers every call, which is the whole hazard.
        jest.mocked(Linking.getInitialURL).mockResolvedValue(launchUrl)

        const first = createLinkSubscription({ handlers, consent: async () => true })
        await flush()
        first.remove()

        const second = createLinkSubscription({ handlers, consent: async () => true })
        await flush()
        second.remove()

        expect(mockOpenUrl).toHaveBeenCalledTimes(1)
        jest.mocked(Linking.getInitialURL).mockResolvedValue(null)
    })
})

it("does not overwrite or dismiss a cross-device presentation already in progress", async () => {
    const onWorking = jest.fn()
    const consent = jest.fn(async () => true)
    createLinkSubscription({ handlers: {}, consent, onWorking, isBusy: () => true })
    mockUrlListener?.({ url: requestUrl() })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(consent).not.toHaveBeenCalled()
    expect(onWorking).not.toHaveBeenCalled()
})
