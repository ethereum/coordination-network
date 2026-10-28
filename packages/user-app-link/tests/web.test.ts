import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { createLinkClient } from "../src/client"
import { decodeRequest, encodeRequest, encodeResponse } from "../src/codec"
import { createRequestHandler } from "../src/handler"
import type { LinkHandlers, LinkOp, Params } from "../src/types"
import {
    createEmbeddedWebLinkTransport,
    createRelayWebLinkTransport,
    browserSessionKey,
    createWebLinkTransport,
    respondToWebLinkRequest
} from "../src/web"
import * as fixtures from "./fixtures"

const MEMBER_ORIGIN = "https://member.example"
const USER_ORIGIN = "https://user.example"

type MessageListener = (event: MessageEvent) => void

function messageHost() {
    const listeners = new Set<MessageListener>()
    return {
        listeners,
        addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: MessageListener) => listeners.delete(listener)
    }
}

function createBrowserHarness(handlers: LinkHandlers) {
    const memberListeners = new Set<MessageListener>()
    const userListeners = new Set<MessageListener>()
    const targets: string[] = []
    let popup: {
        closed: boolean
        close: () => void
        postMessage: (data: unknown, targetOrigin: string) => void
    } | null = null

    const memberWindow = {
        addEventListener: (_type: string, listener: MessageListener) => memberListeners.add(listener),
        removeEventListener: (_type: string, listener: MessageListener) => memberListeners.delete(listener),
        postMessage: (data: unknown, targetOrigin: string) => {
            targets.push(targetOrigin)
            for (const listener of memberListeners) {
                listener({ data, origin: USER_ORIGIN, source: popup } as unknown as MessageEvent)
            }
        },
        open: (url: string) => {
            popup = {
                closed: false,
                close() {
                    this.closed = true
                },
                postMessage(data: unknown) {
                    for (const listener of userListeners) {
                        listener({ data, origin: MEMBER_ORIGIN, source: memberWindow } as unknown as MessageEvent)
                    }
                }
            }

            const currentPopup = popup
            const userWindow = {
                location: { href: url },
                opener: memberWindow,
                addEventListener: (_type: string, listener: MessageListener) => userListeners.add(listener),
                removeEventListener: (_type: string, listener: MessageListener) => userListeners.delete(listener),
                close: () => currentPopup.close()
            }

            queueMicrotask(() => {
                void respondToWebLinkRequest({
                    handler: createRequestHandler({ handlers, consent: async () => true }),
                    allowedMemberOrigins: [MEMBER_ORIGIN],
                    window: userWindow as unknown as Window
                })
            })
            return popup as unknown as Window
        }
    }

    const transport = createWebLinkTransport({
        userAppUrl: `${USER_ORIGIN}/link`,
        userAppOrigin: USER_ORIGIN,
        window: memberWindow as unknown as Window
    })
    const client = createLinkClient({
        caller: { ...fixtures.caller, scheme: MEMBER_ORIGIN },
        callback: fixtures.callback,
        ...transport,
        randomId: () => "web-request"
    })

    return { client, targets, memberListeners, userListeners, getPopup: () => popup }
}

describe("browser round trips", () => {
    const handlers: LinkHandlers = {
        "registration.sign": async () => fixtures.registrationSignResult,
        "credential.issue": async () => fixtures.credentialIssueResult,
        "presentation.create": async () => fixtures.presentationCreateResult
    }

    const cases: [LinkOp, Params<LinkOp>, unknown][] = [
        ["registration.sign", fixtures.registrationSignParams, fixtures.registrationSignResult],
        ["credential.issue", fixtures.credentialIssueParams, fixtures.credentialIssueResult],
        ["presentation.create", fixtures.presentationCreateParams, fixtures.presentationCreateResult]
    ]

    it.each(cases)("carries %s through the popup transport", async (op, params, expected) => {
        const harness = createBrowserHarness(handlers)
        const request = harness.client.request as (nextOp: LinkOp, nextParams: Params<LinkOp>) => Promise<unknown>

        await expect(request(op, params)).resolves.toEqual(expected)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(harness.targets).toEqual(["*", MEMBER_ORIGIN])
        expect(harness.memberListeners.size).toBe(0)
        expect(harness.userListeners.size).toBe(0)
        expect(harness.getPopup()?.closed).toBe(true)
    })
})

describe("createWebLinkTransport security and lifecycle", () => {
    afterEach(() => {
        jest.useRealTimers()
    })

    it("ignores responses from another origin or another window", async () => {
        const listeners = new Set<MessageListener>()
        const popup = { closed: false, close: jest.fn(), postMessage: jest.fn() }
        let openedUrl = ""
        const host = {
            open: (url: string) => {
                openedUrl = url
                return popup
            },
            addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
            removeEventListener: (_type: string, listener: MessageListener) => listeners.delete(listener)
        }
        const transport = createWebLinkTransport({
            userAppUrl: `${USER_ORIGIN}/link`,
            userAppOrigin: USER_ORIGIN,
            window: host as unknown as Window
        })
        const client = createLinkClient({
            caller: fixtures.caller,
            callback: fixtures.callback,
            randomId: () => "secure-request",
            ...transport
        })
        const result = client.request("registration.sign", fixtures.registrationSignParams)
        const request = decodeRequest(openedUrl)
        const response = encodeResponse(fixtures.callback, {
            id: request.id,
            version: "v1",
            ok: true,
            result: fixtures.registrationSignResult
        })
        const deliver = (origin: string, source: unknown) => {
            for (const listener of listeners) listener({ data: response, origin, source } as MessageEvent)
        }

        deliver("https://attacker.example", popup)
        deliver(USER_ORIGIN, {})
        expect(listeners.size).toBe(1)
        deliver(USER_ORIGIN, popup)

        await expect(result).resolves.toEqual(fixtures.registrationSignResult)
    })

    it("reserves and reuses a popup after asynchronous flow work", async () => {
        const popup = { closed: false, location: { href: "" }, close: jest.fn() }
        const host = {
            open: jest.fn(() => popup),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn()
        }
        const transport = createWebLinkTransport({
            userAppUrl: `${USER_ORIGIN}/link`,
            userAppOrigin: USER_ORIGIN,
            window: host as unknown as Window
        })

        transport.prepare()
        await Promise.resolve()
        const opening = transport.openUrl("userapp://v1/request?payload=request")

        expect(host.open).toHaveBeenCalledTimes(1)
        expect(popup.location.href).toBe(`${USER_ORIGIN}/link?payload=request`)
        transport.close()
        await expect(opening).rejects.toThrow("popup closed")
        expect(popup.close).toHaveBeenCalled()
    })

    it("reuses the approved popup across consecutive requests", async () => {
        const listeners = new Set<MessageListener>()
        const popup = { closed: false, location: { href: "" }, close: jest.fn(), postMessage: jest.fn() }
        const host = {
            open: jest.fn(() => popup),
            addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
            removeEventListener: (_type: string, listener: MessageListener) => listeners.delete(listener)
        }
        const transport = createWebLinkTransport({
            userAppUrl: `${USER_ORIGIN}/link`,
            userAppOrigin: USER_ORIGIN,
            window: host as unknown as Window
        })
        const client = createLinkClient({
            caller: fixtures.caller,
            callback: fixtures.callback,
            randomId: () => "consecutive",
            ...transport
        })

        transport.prepare()
        const first = client.request("registration.sign", fixtures.registrationSignParams)
        const firstResponse = encodeResponse(fixtures.callback, {
            id: "consecutive",
            version: "v1",
            ok: true,
            result: fixtures.registrationSignResult
        })
        for (const listener of listeners)
            listener({ data: firstResponse, origin: USER_ORIGIN, source: popup } as unknown as MessageEvent)
        await first

        const second = client.request("registration.sign", fixtures.registrationSignParams)
        expect(host.open).toHaveBeenCalledTimes(1)
        const secondResponse = encodeResponse(fixtures.callback, {
            id: "consecutive",
            version: "v1",
            ok: true,
            result: fixtures.registrationSignResult
        })
        for (const listener of listeners)
            listener({ data: secondResponse, origin: USER_ORIGIN, source: popup } as unknown as MessageEvent)
        await expect(second).resolves.toEqual(fixtures.registrationSignResult)

        transport.close()
        expect(popup.close).toHaveBeenCalledTimes(1)
    })

    it("rejects when the popup closes before responding", async () => {
        jest.useFakeTimers()
        const popup = { closed: false, close: jest.fn(), postMessage: jest.fn() }
        const host = {
            open: () => popup,
            addEventListener: jest.fn(),
            removeEventListener: jest.fn()
        }
        const client = createLinkClient({
            caller: fixtures.caller,
            callback: fixtures.callback,
            ...createWebLinkTransport({
                userAppUrl: `${USER_ORIGIN}/link`,
                userAppOrigin: USER_ORIGIN,
                closePollIntervalMs: 10,
                closeGracePeriodMs: 20,
                window: host as unknown as Window
            })
        })

        const result = client.request("registration.sign", fixtures.registrationSignParams)
        popup.closed = true
        jest.advanceTimersByTime(30)

        await expect(result).rejects.toThrow("popup closed")
        expect(host.removeEventListener).toHaveBeenCalled()
    })

    it("accepts a queued response observed just after the popup closes", async () => {
        jest.useFakeTimers()
        const listeners = new Set<MessageListener>()
        const popup = { closed: false, close: jest.fn() }
        const host = {
            open: () => popup,
            addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
            removeEventListener: (_type: string, listener: MessageListener) => listeners.delete(listener)
        }
        const client = createLinkClient({
            caller: fixtures.caller,
            callback: fixtures.callback,
            randomId: () => "queued-response",
            ...createWebLinkTransport({
                userAppUrl: `${USER_ORIGIN}/link`,
                userAppOrigin: USER_ORIGIN,
                closePollIntervalMs: 10,
                closeGracePeriodMs: 100,
                window: host as unknown as Window
            })
        })

        const result = client.request("registration.sign", fixtures.registrationSignParams)
        popup.closed = true
        jest.advanceTimersByTime(10)
        const response = encodeResponse(fixtures.callback, {
            id: "queued-response",
            version: "v1",
            ok: true,
            result: fixtures.registrationSignResult
        })
        for (const listener of listeners) {
            listener({ data: response, origin: USER_ORIGIN, source: popup } as unknown as MessageEvent)
        }

        await expect(result).resolves.toEqual(fixtures.registrationSignResult)
    })

    it("keeps the protocol rule that rejects an http callback", async () => {
        const host = { open: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn() }
        const client = createLinkClient({
            caller: fixtures.caller,
            callback: "https://member.example/response",
            ...createWebLinkTransport({
                userAppUrl: `${USER_ORIGIN}/link`,
                userAppOrigin: USER_ORIGIN,
                window: host as unknown as Window
            })
        })

        await expect(client.request("registration.sign", fixtures.registrationSignParams)).rejects.toMatchObject({
            code: "INVALID_REQUEST"
        })
        expect(host.open).not.toHaveBeenCalled()
    })
})

describe("respondToWebLinkRequest", () => {
    afterEach(() => {
        jest.useRealTimers()
    })

    function responderHarness(origin = MEMBER_ORIGIN, callerOrigin = MEMBER_ORIGIN) {
        const listeners = new Set<MessageListener>()
        const responseTargets: string[] = []
        const opener = {
            postMessage: (data: unknown, targetOrigin: string) => {
                if (targetOrigin === "*") {
                    for (const listener of listeners) {
                        listener({
                            data: "coordination-network:member-app-hello:v1",
                            origin,
                            source: opener
                        } as unknown as MessageEvent)
                    }
                } else {
                    responseTargets.push(targetOrigin)
                }
            }
        }
        const requestUrl = encodeRequest(
            {
                id: "browser-request",
                version: "v1",
                caller: { name: "Example Member App", scheme: callerOrigin },
                callback: fixtures.callback,
                op: "registration.sign",
                params: fixtures.registrationSignParams
            },
            { scheme: "userapp" }
        )
        const host = {
            location: { href: requestUrl },
            opener,
            addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
            removeEventListener: (_type: string, listener: MessageListener) => listeners.delete(listener),
            close: jest.fn()
        }
        return { host, listeners, responseTargets }
    }

    it("posts only to the authenticated member origin", async () => {
        const { host, listeners, responseTargets } = responderHarness()
        const handler = { handle: jest.fn(async () => "examplemember://v1/response?payload=result") }

        await respondToWebLinkRequest({
            handler,
            allowedMemberOrigins: [MEMBER_ORIGIN],
            window: host as unknown as Window
        })

        expect(responseTargets).toEqual([MEMBER_ORIGIN])
        expect(listeners.size).toBe(0)
        expect(host.close).toHaveBeenCalled()
    })

    it("rejects an opener outside the allowed member origins", async () => {
        jest.useFakeTimers()
        const { host } = responderHarness("https://attacker.example")
        const responding = respondToWebLinkRequest({
            handler: { handle: jest.fn(async () => "unused") },
            allowedMemberOrigins: [MEMBER_ORIGIN],
            handshakeTimeoutMs: 10,
            window: host as unknown as Window
        })

        jest.advanceTimersByTime(10)
        await expect(responding).rejects.toThrow("handshake timed out")
        expect(host.close).toHaveBeenCalled()
    })

    it("closes when request handling fails", async () => {
        const { host } = responderHarness()
        await expect(
            respondToWebLinkRequest({
                handler: { handle: jest.fn(async () => Promise.reject(new Error("broken request"))) },
                allowedMemberOrigins: [MEMBER_ORIGIN],
                window: host as unknown as Window
            })
        ).rejects.toThrow("broken request")
        expect(host.close).toHaveBeenCalled()
    })

    it("keeps a user-approved window open for a multi-request member action", async () => {
        const { host } = responderHarness()
        await respondToWebLinkRequest({
            handler: { handle: jest.fn(async () => "response") },
            allowedMemberOrigins: [MEMBER_ORIGIN],
            closeAfterResponding: false,
            window: host as unknown as Window
        })

        expect(host.close).not.toHaveBeenCalled()
    })

    it("rejects a caller origin that does not match the authenticated opener", async () => {
        const { host } = responderHarness(MEMBER_ORIGIN, "https://attacker.example")
        await expect(
            respondToWebLinkRequest({
                handler: { handle: jest.fn(async () => "unused") },
                allowedMemberOrigins: [MEMBER_ORIGIN],
                window: host as unknown as Window
            })
        ).rejects.toThrow("caller does not match")
        expect(host.close).toHaveBeenCalled()
    })
})

describe("embedded browser transport", () => {
    it("navigates an iframe and accepts only its response", async () => {
        const listeners = new Set<MessageListener>()
        const frameWindow = { postMessage: jest.fn() }
        const frame = { src: "", contentWindow: frameWindow }
        const host = {
            addEventListener: (_type: string, listener: MessageListener) => listeners.add(listener),
            removeEventListener: (_type: string, listener: MessageListener) => listeners.delete(listener)
        }
        const transport = createEmbeddedWebLinkTransport({
            userAppUrl: `${USER_ORIGIN}/`,
            userAppOrigin: USER_ORIGIN,
            frame: frame as unknown as HTMLIFrameElement,
            window: host as unknown as Window
        })
        const client = createLinkClient({
            caller: fixtures.caller,
            callback: fixtures.callback,
            randomId: () => "embedded",
            ...transport
        })
        const result = client.request("registration.sign", fixtures.registrationSignParams)
        expect(frame.src).toContain("payload=")
        for (const listener of listeners) {
            listener({
                data: "coordination-network:user-app-ready:v1",
                origin: USER_ORIGIN,
                source: frameWindow
            } as unknown as MessageEvent)
        }
        expect(frameWindow.postMessage).toHaveBeenCalledWith("coordination-network:member-app-hello:v1", USER_ORIGIN)
        const response = encodeResponse(fixtures.callback, {
            id: "embedded",
            version: "v1",
            ok: true,
            result: fixtures.registrationSignResult
        })
        for (const listener of listeners)
            listener({ data: response, origin: USER_ORIGIN, source: frameWindow } as unknown as MessageEvent)
        await expect(result).resolves.toEqual(fixtures.registrationSignResult)
    })
})

describe("relay browser transport", () => {
    it("delivers a request and receives its response without opening a window", async () => {
        const responseUrl = "alpha://v1/response?payload=result"
        let call = 0
        const fetcher = jest.fn(async () => {
            call += 1
            return call === 1
                ? ({ ok: true } as Response)
                : ({ ok: true, json: async () => [{ seq: 1, url: responseUrl }] } as Response)
        })
        const transport = createRelayWebLinkTransport({
            relayUrl: "http://relay.example:4177",
            token: "a".repeat(64),
            sender: MEMBER_ORIGIN,
            pollIntervalMs: 60_000,
            fetcher: fetcher as unknown as typeof fetch
        })
        const received: string[] = []

        await transport.openUrl("userapp://v1/request?payload=request")
        const unsubscribe = transport.onUrl((url) => received.push(url))
        await new Promise((resolve) => setTimeout(resolve, 0))
        unsubscribe()

        expect(fetcher).toHaveBeenNthCalledWith(
            1,
            "http://relay.example:4177/v1/requests",
            expect.objectContaining({
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${"a".repeat(64)}` }
            })
        )
        expect(received).toEqual([responseUrl])
    })
})

describe("relay session pairing", () => {
    function browser(href: string, promptValue: string | null = null) {
        const values = new Map<string, string>()
        const replaceState = jest.fn()
        const prompt = jest.fn(() => promptValue)
        const host = {
            location: { href },
            history: { replaceState },
            prompt,
            sessionStorage: {
                getItem: (key: string) => values.get(key) ?? null,
                setItem: (key: string, value: string) => values.set(key, value)
            }
        } as unknown as Window
        return { host, replaceState, prompt, values }
    }

    it("takes the session key out of the address bar and preserves the request and other fragment fields", () => {
        const token = "a".repeat(64)
        const { host, replaceState, prompt, values } = browser(
            `http://wallet.test/?payload=request#tab=one&relayKey=${token}`
        )
        expect(browserSessionKey("http://relay.test", host)).toBe(token)
        expect(replaceState).toHaveBeenCalledWith(null, "", "http://wallet.test/?payload=request#tab=one")
        expect(values.get("coordination-session-key:relayKey:http://relay.test")).toBe(token)
        expect(prompt).not.toHaveBeenCalled()
    })

    it("asks once per tab and relay, without writing the key into a URL", () => {
        const token = "b".repeat(64)
        const { host, prompt, replaceState } = browser("http://member.test/", token)
        expect(browserSessionKey("http://relay.test", host)).toBe(token)
        expect(browserSessionKey("http://relay.test", host)).toBe(token)
        expect(prompt).toHaveBeenCalledTimes(1)
        expect(replaceState).not.toHaveBeenCalled()
    })

    it("keeps member API keys separate from the relay key", () => {
        const { host, values } = browser(`http://member.test/#memberKey=${"c".repeat(64)}`)
        expect(browserSessionKey("http://server.test", host, "memberKey")).toBe("c".repeat(64))
        expect(values.get("coordination-session-key:memberKey:http://server.test")).toBe("c".repeat(64))
        expect(values.has("coordination-session-key:relayKey:http://server.test")).toBe(false)
    })

    it("asks for the member key with its own prompt and rejects a cancelled prompt", () => {
        const { host, prompt } = browser("http://member.test/")

        expect(() => browserSessionKey("http://server.test", host, "memberKey")).toThrow(
            "A demo connection key is required"
        )
        expect(prompt).toHaveBeenCalledWith("Member connection key")
    })

    it("refuses missing or malformed keys", () => {
        expect(() => browserSessionKey("http://relay.test", browser("http://member.test/").host)).toThrow(
            /connection key/
        )
        expect(() =>
            browserSessionKey("http://relay.test", browser("http://member.test/#relayKey=wrong").host)
        ).toThrow(/connection key/)
    })
})

describe("transport option guards", () => {
    const host = { open: jest.fn(), addEventListener: jest.fn(), removeEventListener: jest.fn() }
    const frame = { src: "", contentWindow: null } as unknown as HTMLIFrameElement
    const create = {
        popup: (userAppUrl: string, userAppOrigin: string) =>
            createWebLinkTransport({ userAppUrl, userAppOrigin, window: host as unknown as Window }),
        embedded: (userAppUrl: string, userAppOrigin: string) =>
            createEmbeddedWebLinkTransport({ userAppUrl, userAppOrigin, frame, window: host as unknown as Window })
    }

    describe.each(["popup", "embedded"] as const)("%s", (kind) => {
        it("rejects a non-absolute origin", () => {
            expect(() => create[kind](`${USER_ORIGIN}/link`, "not a url")).toThrow(
                "userAppOrigin must be an absolute browser URL"
            )
        })

        it("rejects an origin that is not http or https", () => {
            expect(() => create[kind](`${USER_ORIGIN}/link`, "data:text/plain,x")).toThrow(
                "userAppOrigin must have an http or https origin"
            )
        })

        it("rejects a user app url outside the trusted origin", () => {
            expect(() => create[kind]("https://other.example/link", USER_ORIGIN)).toThrow(
                "userAppUrl must belong to userAppOrigin"
            )
        })

        it("rejects a request url without an encoded query", async () => {
            await expect(
                create[kind](`${USER_ORIGIN}/link`, USER_ORIGIN).openUrl("userapp://v1/request")
            ).rejects.toThrow("missing its encoded query")
        })
    })
})

describe("popup transport edge cases", () => {
    type Transport = ReturnType<typeof createWebLinkTransport>

    afterEach(() => {
        jest.useRealTimers()
    })

    function setup(popup: unknown, extra: { popupName?: string; popupFeatures?: string } = {}) {
        const host = { open: jest.fn(() => popup), ...messageHost() }
        const transport = createWebLinkTransport({
            userAppUrl: `${USER_ORIGIN}/link`,
            userAppOrigin: USER_ORIGIN,
            window: host as unknown as Window,
            ...extra
        })
        const deliver = (data: unknown, origin = USER_ORIGIN, source: unknown = popup) => {
            for (const listener of host.listeners) listener({ data, origin, source } as unknown as MessageEvent)
        }
        return { host, transport, listeners: host.listeners, deliver }
    }

    it("rejects when the browser blocks the popup", async () => {
        const { host, transport } = setup(null)

        await expect(transport.openUrl("userapp://v1/request?payload=request")).rejects.toThrow(
            "user app popup was blocked"
        )
        expect(host.open).toHaveBeenCalledTimes(1)
    })

    it("opens a fresh popup when the reserved one was closed", () => {
        const popup = { closed: true, location: { href: "" }, close: jest.fn() }
        const { host, transport } = setup(popup)

        transport.prepare()
        void transport.openUrl("userapp://v1/request?payload=request").catch(() => {})

        expect(host.open).toHaveBeenCalledTimes(2)
        expect(popup.location.href).toBe("")
        transport.close()
    })

    it.each<[string, (transport: Transport) => void, string]>([
        ["prepare", (transport) => transport.prepare(), `${USER_ORIGIN}/link`],
        [
            "openUrl",
            (transport) => void transport.openUrl("userapp://v1/request?payload=request").catch(() => {}),
            `${USER_ORIGIN}/link?payload=request`
        ]
    ])("passes the popup name and features to window.open from %s", (_name, act, url) => {
        const popup = { closed: false, close: jest.fn() }
        const { host, transport } = setup(popup, { popupName: "custom", popupFeatures: "width=400" })

        act(transport)

        expect(host.open).toHaveBeenCalledWith(url, "custom", "width=400")
        transport.close()
    })

    it("ignores messages before a popup exists and non-string payloads", async () => {
        const popup = { closed: false, close: jest.fn(), postMessage: jest.fn() }
        const { transport, deliver } = setup(popup)
        const received: string[] = []
        transport.onUrl((url) => received.push(url))

        deliver("early", USER_ORIGIN, null)
        const opening = transport.openUrl("userapp://v1/request?payload=request")
        deliver({ not: "a string" })
        expect(received).toEqual([])
        deliver("memberapp://v1/response?payload=ok")

        await expect(opening).resolves.toBeUndefined()
        expect(received).toEqual(["memberapp://v1/response?payload=ok"])
    })

    it("answers the ready message with the hello handshake", () => {
        const popup = { closed: false, close: jest.fn(), postMessage: jest.fn() }
        const { transport, deliver } = setup(popup)
        const received: string[] = []
        transport.onUrl((url) => received.push(url))
        transport.prepare()

        deliver("coordination-network:user-app-ready:v1")

        expect(popup.postMessage).toHaveBeenCalledWith("coordination-network:member-app-hello:v1", USER_ORIGIN)
        expect(received).toEqual([])
    })

    it("does not reject an open request that was already answered before close", async () => {
        const popup = { closed: false, close: jest.fn(), postMessage: jest.fn() }
        const { transport, deliver } = setup(popup)
        transport.onUrl(() => {})
        const opening = transport.openUrl("userapp://v1/request?payload=request")

        deliver("memberapp://v1/response?payload=ok")
        expect(() => transport.close()).not.toThrow()

        await expect(opening).resolves.toBeUndefined()
        expect(popup.close).toHaveBeenCalledTimes(1)
    })

    it("close without a popup is a no-op", () => {
        const { transport } = setup(null)
        expect(() => transport.close()).not.toThrow()
    })

    it("resolves a pending open when the listener unsubscribes", async () => {
        const popup = { closed: false, close: jest.fn(), postMessage: jest.fn() }
        const { transport, listeners } = setup(popup)
        const unsubscribe = transport.onUrl(() => {})
        const opening = transport.openUrl("userapp://v1/request?payload=request")

        unsubscribe()

        await expect(opening).resolves.toBeUndefined()
        expect(listeners.size).toBe(0)
    })

    it("keeps waiting while the closed popup is inside the grace period", async () => {
        jest.useFakeTimers()
        const popup = { closed: false, close: jest.fn(), postMessage: jest.fn() }
        const { transport } = setup(popup)
        const onSettled = jest.fn()
        const opening = transport.openUrl("userapp://v1/request?payload=request")
        opening.then(onSettled, onSettled)

        jest.advanceTimersByTime(1_000)
        await Promise.resolve()
        expect(onSettled).not.toHaveBeenCalled()

        popup.closed = true
        jest.advanceTimersByTime(100)
        await Promise.resolve()
        expect(onSettled).not.toHaveBeenCalled()

        jest.advanceTimersByTime(300)
        await expect(opening).rejects.toThrow("popup closed before responding")
    })
})

describe("respondToWebLinkRequest preconditions", () => {
    const handler = { handle: jest.fn(async () => "response") }

    it("rejects a window with neither an opener nor a parent frame", async () => {
        const host: { opener: null; parent?: unknown } = { opener: null }
        host.parent = host

        await expect(
            respondToWebLinkRequest({
                handler,
                allowedMemberOrigins: [MEMBER_ORIGIN],
                window: host as unknown as Window
            })
        ).rejects.toThrow("user app was not opened or embedded by a member app")
    })

    it.each([
        ["an empty origin allow-list", [], "allowedMemberOrigins must not be empty"],
        [
            "an allowed origin that is not an absolute url",
            ["member"],
            "allowedMemberOrigins must be an absolute browser URL"
        ]
    ])("rejects %s and still closes the popup", async (_name, allowedMemberOrigins, message) => {
        const host = { opener: {}, close: jest.fn() }

        await expect(
            respondToWebLinkRequest({ handler, allowedMemberOrigins, window: host as unknown as Window })
        ).rejects.toThrow(message)
        expect(host.close).toHaveBeenCalled()
    })

    it("answers an embedding parent frame and leaves the window open", async () => {
        const messages = messageHost()
        const parent = {
            postMessage: jest.fn((_data: unknown, targetOrigin: string) => {
                if (targetOrigin !== "*") return
                for (const listener of messages.listeners) {
                    listener({
                        data: "coordination-network:member-app-hello:v1",
                        origin: MEMBER_ORIGIN,
                        source: parent
                    } as unknown as MessageEvent)
                }
            })
        }
        const requestUrl = encodeRequest(
            {
                id: "framed",
                version: "v1",
                caller: { name: "Example Member App", scheme: MEMBER_ORIGIN },
                callback: fixtures.callback,
                op: "registration.sign",
                params: fixtures.registrationSignParams
            },
            { scheme: "userapp" }
        )
        const host = {
            opener: null,
            parent,
            location: { href: requestUrl },
            ...messages,
            close: jest.fn()
        }

        await respondToWebLinkRequest({
            handler,
            allowedMemberOrigins: [MEMBER_ORIGIN],
            window: host as unknown as Window
        })

        expect(parent.postMessage).toHaveBeenLastCalledWith("response", MEMBER_ORIGIN)
        expect(host.close).not.toHaveBeenCalled()
    })
})

describe("embedded transport edge cases", () => {
    function setup(contentWindow: unknown = { postMessage: jest.fn() }) {
        const frame = { src: "", contentWindow }
        const host = messageHost()
        const transport = createEmbeddedWebLinkTransport({
            userAppUrl: `${USER_ORIGIN}/`,
            userAppOrigin: USER_ORIGIN,
            frame: frame as unknown as HTMLIFrameElement,
            window: host as unknown as Window
        })
        const deliver = (data: unknown, origin = USER_ORIGIN, source: unknown = contentWindow) => {
            for (const listener of host.listeners) listener({ data, origin, source } as unknown as MessageEvent)
        }
        return { frame, transport, listeners: host.listeners, deliver }
    }

    it("prepare leaves the frame alone and close blanks it", async () => {
        const { frame, transport } = setup()
        await transport.openUrl("userapp://v1/request?payload=request")
        expect(frame.src).toBe(`${USER_ORIGIN}/?payload=request`)

        transport.prepare()
        expect(frame.src).toBe(`${USER_ORIGIN}/?payload=request`)

        transport.close()
        expect(frame.src).toBe("about:blank")
    })

    it("ignores foreign origins, other windows and non-string payloads", () => {
        const frameWindow = { postMessage: jest.fn() }
        const { transport, deliver } = setup(frameWindow)
        const received: string[] = []
        transport.onUrl((url) => received.push(url))

        deliver("memberapp://v1/response", "https://attacker.example")
        deliver("memberapp://v1/response", USER_ORIGIN, {})
        deliver({ not: "a string" })

        expect(received).toEqual([])
        expect(frameWindow.postMessage).not.toHaveBeenCalled()
    })

    it("tolerates a detached frame during the ready handshake and removes the listener on unsubscribe", () => {
        const { transport, deliver, listeners } = setup(null)
        const received: string[] = []
        const unsubscribe = transport.onUrl((url) => received.push(url))

        expect(() => deliver("coordination-network:user-app-ready:v1", USER_ORIGIN, null)).not.toThrow()
        unsubscribe()

        expect(listeners.size).toBe(0)
        expect(received).toEqual([])
    })
})

describe("default browser window", () => {
    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window")
    })

    function installWindow(host: unknown) {
        Object.defineProperty(globalThis, "window", { value: host, configurable: true, writable: true })
    }

    it("is used by the popup, embedded and responder helpers when none is injected", async () => {
        const popup = { closed: false, close: jest.fn() }
        const host = { open: jest.fn(() => popup), ...messageHost(), opener: null, parent: null }
        installWindow(host)

        const popupTransport = createWebLinkTransport({ userAppUrl: `${USER_ORIGIN}/link`, userAppOrigin: USER_ORIGIN })
        popupTransport.prepare()
        popupTransport.prepare()
        expect(host.open).toHaveBeenCalledTimes(1)

        const frame = { src: "", contentWindow: null } as unknown as HTMLIFrameElement
        const unsubscribe = createEmbeddedWebLinkTransport({
            userAppUrl: `${USER_ORIGIN}/link`,
            userAppOrigin: USER_ORIGIN,
            frame
        }).onUrl(() => {})
        expect(host.listeners.size).toBe(1)
        unsubscribe()

        await expect(
            respondToWebLinkRequest({
                handler: { handle: jest.fn(async () => "response") },
                allowedMemberOrigins: [MEMBER_ORIGIN]
            })
        ).rejects.toThrow("user app was not opened or embedded by a member app")
    })

    it("browserSessionKey reads the global window by default", () => {
        const token = "e".repeat(64)
        const setItem = jest.fn()
        installWindow({
            location: { href: `http://x/#relayKey=${token}` },
            history: { replaceState: jest.fn() },
            sessionStorage: { getItem: () => null, setItem }
        })

        expect(browserSessionKey("http://relay.test")).toBe(token)
        expect(setItem).toHaveBeenCalledWith("coordination-session-key:relayKey:http://relay.test", token)
    })
})

describe("relay transport edge cases", () => {
    afterEach(() => {
        jest.useRealTimers()
        jest.restoreAllMocks()
    })

    const options = { relayUrl: "http://relay.example:4177", token: "a".repeat(64), sender: MEMBER_ORIGIN }

    it("fails when the relay refuses the request", async () => {
        const fetcher = jest.fn(async () => ({ ok: false }) as Response)
        const transport = createRelayWebLinkTransport({ ...options, fetcher: fetcher as unknown as typeof fetch })

        await expect(transport.openUrl("userapp://v1/request?payload=request")).rejects.toThrow(
            "wallet request could not be delivered"
        )
    })

    it("uses the global fetch when none is injected", async () => {
        const fetchMock = jest.fn(async () => ({ ok: true }) as Response)
        jest.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch)
        const transport = createRelayWebLinkTransport(options)

        await transport.openUrl("userapp://v1/request?payload=request")

        expect(fetchMock).toHaveBeenCalledWith("http://relay.example:4177/v1/requests", expect.anything())
    })

    it("skips a poll that is already running and acknowledges after delivery", async () => {
        jest.useFakeTimers()
        let release: (response: Response) => void = () => {}
        const calls: string[] = []
        const fetcher = jest.fn((url: string, init?: RequestInit) => {
            calls.push(`${init?.method ?? "GET"} ${url}`)
            if (init?.method === "DELETE") return Promise.resolve({ ok: true } as Response)
            return new Promise<Response>((resolve) => {
                release = resolve
            })
        })
        const transport = createRelayWebLinkTransport({
            ...options,
            pollIntervalMs: 10,
            fetcher: fetcher as unknown as typeof fetch
        })
        const received: string[] = []
        const unsubscribe = transport.onUrl((url) => received.push(url))

        jest.advanceTimersByTime(50)
        expect(fetcher).toHaveBeenCalledTimes(1)

        release({ ok: true, json: async () => [{ seq: 3, url: "alpha://v1/response?payload=1" }] } as Response)
        await jest.advanceTimersByTimeAsync(0)
        expect(received).toEqual(["alpha://v1/response?payload=1"])
        expect(calls).toContain(
            `DELETE http://relay.example:4177/v1/responses?sender=${encodeURIComponent(MEMBER_ORIGIN)}&after=3`
        )

        unsubscribe()
        const before = fetcher.mock.calls.length
        jest.advanceTimersByTime(100)
        expect(fetcher).toHaveBeenCalledTimes(before)
    })

    it("does nothing when the relay answers a poll with an error or the fetch throws", async () => {
        jest.useFakeTimers()
        const responses = [
            () => Promise.resolve({ ok: false, json: async () => [{ seq: 1, url: "x" }] } as unknown as Response),
            () => Promise.reject(new Error("down"))
        ]
        const fetcher = jest.fn(
            () => responses.shift()?.() ?? Promise.resolve({ ok: true, json: async () => [] } as unknown as Response)
        )
        const transport = createRelayWebLinkTransport({
            ...options,
            pollIntervalMs: 10,
            fetcher: fetcher as unknown as typeof fetch
        })
        const received: string[] = []
        const unsubscribe = transport.onUrl((url) => received.push(url))

        await jest.advanceTimersByTimeAsync(30)
        unsubscribe()

        expect(fetcher.mock.calls.length).toBeGreaterThanOrEqual(3)
        expect(received).toEqual([])
    })

    it("polls every 500ms by default", async () => {
        jest.useFakeTimers()
        const fetcher = jest.fn(async () => ({ ok: true, json: async () => [] }) as unknown as Response)
        const transport = createRelayWebLinkTransport({ ...options, fetcher: fetcher as unknown as typeof fetch })
        const unsubscribe = transport.onUrl(() => {})

        await jest.advanceTimersByTimeAsync(0)
        expect(fetcher).toHaveBeenCalledTimes(1)
        await jest.advanceTimersByTimeAsync(499)
        expect(fetcher).toHaveBeenCalledTimes(1)
        await jest.advanceTimersByTimeAsync(1)
        expect(fetcher).toHaveBeenCalledTimes(2)
        unsubscribe()
    })
})
