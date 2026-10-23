import type { LinkClientOptions } from "./client"
import { decodeRequest } from "./codec"
import type { RequestHandler } from "./handler"

export interface WebLinkTransportOptions {
    /** Browser URL of the user web app. The encoded request query is appended to this URL. */
    userAppUrl: string
    /** Exact origin trusted to return responses, for example `http://localhost:5173`. */
    userAppOrigin: string
    popupName?: string
    popupFeatures?: string
    /** How often to detect a popup closed before responding. Default 100ms. */
    closePollIntervalMs?: number
    /** Time to wait for an already-posted response after observing a closed popup. Default 250ms. */
    closeGracePeriodMs?: number
    /** Injectable for tests; defaults to the current browser window. */
    window?: Window
}

export type WebLinkTransport = Pick<LinkClientOptions, "openUrl" | "onUrl"> & {
    /** Reserves the popup synchronously inside a click handler before asynchronous flow work begins. */
    prepare(): void
    close(): void
}

const DEFAULT_CLOSE_POLL_INTERVAL_MS = 100
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5_000
const READY_MESSAGE = "coordination-network:user-app-ready:v1"
const HELLO_MESSAGE = "coordination-network:member-app-hello:v1"

function normalizedOrigin(value: string, option: string): string {
    let origin: string
    try {
        origin = new URL(value).origin
    } catch {
        throw new Error(`${option} must be an absolute browser URL`)
    }
    if (origin === "null") {
        throw new Error(`${option} must have an http or https origin`)
    }
    return origin
}

/**
 * Supplies the two transport functions consumed by `createLinkClient`. The protocol request stays
 * unchanged; only its query string is carried to the browser user app instead of a mobile scheme.
 */
export function createWebLinkTransport(options: WebLinkTransportOptions): WebLinkTransport {
    const host = options.window ?? window
    const userAppOrigin = normalizedOrigin(options.userAppOrigin, "userAppOrigin")
    const popupUrl = new URL(options.userAppUrl)
    if (popupUrl.origin !== userAppOrigin) {
        throw new Error("userAppUrl must belong to userAppOrigin")
    }

    let popup: Window | null = null
    let listener: ((url: string) => void) | null = null
    let closeTimer: ReturnType<typeof setInterval> | null = null
    let finishOpen: (() => void) | null = null
    let failOpen: ((error: Error) => void) | null = null
    let closedAt: number | null = null

    function clearCloseTimer(): void {
        if (closeTimer !== null) {
            clearInterval(closeTimer)
            closeTimer = null
        }
    }

    function handleMessage(event: MessageEvent): void {
        if (!popup || event.source !== popup || event.origin !== userAppOrigin) {
            return
        }
        if (event.data === READY_MESSAGE) {
            popup.postMessage(HELLO_MESSAGE, userAppOrigin)
            return
        }
        if (typeof event.data !== "string") return

        const resolve = finishOpen
        finishOpen = null
        failOpen = null
        clearCloseTimer()
        resolve?.()
        listener?.(event.data)
    }

    return {
        prepare(): void {
            if (popup && !popup.closed) return
            popup = host.open(popupUrl.toString(), options.popupName ?? "coordination-user-app", options.popupFeatures)
        },

        close(): void {
            popup?.close()
            popup = null
            const fail = failOpen
            finishOpen = null
            failOpen = null
            clearCloseTimer()
            fail?.(new Error("user app popup closed before responding"))
        },

        onUrl(nextListener): () => void {
            listener = nextListener
            host.addEventListener("message", handleMessage)
            return () => {
                host.removeEventListener("message", handleMessage)
                listener = null
                clearCloseTimer()
                finishOpen?.()
                finishOpen = null
                failOpen = null
            }
        },

        openUrl(requestUrl): Promise<void> {
            const queryIndex = requestUrl.indexOf("?")
            if (queryIndex === -1) {
                return Promise.reject(new Error("browser link request is missing its encoded query"))
            }

            const destination = new URL(popupUrl.toString())
            destination.search = requestUrl.slice(queryIndex)
            if (popup && !popup.closed) {
                popup.location.href = destination.toString()
            } else {
                popup = host.open(
                    destination.toString(),
                    options.popupName ?? "coordination-user-app",
                    options.popupFeatures
                )
            }
            if (!popup) {
                return Promise.reject(new Error("user app popup was blocked"))
            }
            closedAt = null

            return new Promise<void>((resolve, reject) => {
                finishOpen = resolve
                failOpen = reject
                closeTimer = setInterval(() => {
                    if (!popup?.closed) return

                    closedAt ??= Date.now()
                    if (Date.now() - closedAt < (options.closeGracePeriodMs ?? 250)) return

                    const fail = failOpen
                    finishOpen = null
                    failOpen = null
                    clearCloseTimer()
                    fail?.(new Error("user app popup closed before responding"))
                }, options.closePollIntervalMs ?? DEFAULT_CLOSE_POLL_INTERVAL_MS)
            })
        }
    }
}

export interface WebLinkResponderOptions {
    handler: RequestHandler
    /** Member-app origins allowed to open the user app and receive a response. */
    allowedMemberOrigins: readonly string[]
    /** Maximum time to wait for the opener handshake. Default 5000ms. */
    handshakeTimeoutMs?: number
    /** Close the user-app popup after posting. Default true. */
    closeAfterResponding?: boolean
    /** Injectable for tests; defaults to the current browser window. */
    window?: Window
}

function authenticateMemberApp(
    host: Window,
    recipient: Window,
    allowedMemberOrigins: ReadonlySet<string>,
    timeoutMs: number
): Promise<string> {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            clearTimeout(timer)
            host.removeEventListener("message", handleMessage)
        }
        const handleMessage = (event: MessageEvent) => {
            if (event.source !== recipient || event.data !== HELLO_MESSAGE || !allowedMemberOrigins.has(event.origin))
                return
            cleanup()
            resolve(event.origin)
        }
        const timer = setTimeout(() => {
            cleanup()
            reject(new Error("member app origin handshake timed out"))
        }, timeoutMs)

        host.addEventListener("message", handleMessage)
        recipient.postMessage(READY_MESSAGE, "*")
    })
}

/** Authenticates the opener, dispatches the request, and posts the response to its verified origin. */
export async function respondToWebLinkRequest(options: WebLinkResponderOptions): Promise<void> {
    const host = options.window ?? window
    const recipient = host.opener ?? (host.parent !== host ? host.parent : null)
    if (!recipient) throw new Error("user app was not opened or embedded by a member app")
    try {
        const allowedMemberOrigins = new Set(
            options.allowedMemberOrigins.map((origin) => normalizedOrigin(origin, "allowedMemberOrigins"))
        )
        if (allowedMemberOrigins.size === 0) throw new Error("allowedMemberOrigins must not be empty")
        const memberAppOrigin = await authenticateMemberApp(
            host,
            recipient,
            allowedMemberOrigins,
            options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
        )
        const request = decodeRequest(host.location.href)
        if (normalizedOrigin(request.caller.scheme, "caller.scheme") !== memberAppOrigin) {
            throw new Error("request caller does not match the authenticated member app origin")
        }

        const response = await options.handler.handle(host.location.href)
        recipient.postMessage(response, memberAppOrigin)
        // Give the queued postMessage a task to reach the opener before closing the popup.
        await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
        if (host.opener && (options.closeAfterResponding ?? true)) host.close()
    }
}

export interface EmbeddedWebLinkTransportOptions {
    userAppUrl: string
    userAppOrigin: string
    frame: HTMLIFrameElement
    window?: Window
}

/** Carries the browser protocol through an in-page iframe, avoiding popup-blocker behavior. */
export function createEmbeddedWebLinkTransport(options: EmbeddedWebLinkTransportOptions): WebLinkTransport {
    const host = options.window ?? window
    const userAppOrigin = normalizedOrigin(options.userAppOrigin, "userAppOrigin")
    const userAppUrl = new URL(options.userAppUrl)
    if (userAppUrl.origin !== userAppOrigin) throw new Error("userAppUrl must belong to userAppOrigin")
    let listener: ((url: string) => void) | null = null
    const handleMessage = (event: MessageEvent) => {
        if (event.origin !== userAppOrigin || event.source !== options.frame.contentWindow) return
        if (event.data === READY_MESSAGE) {
            options.frame.contentWindow?.postMessage(HELLO_MESSAGE, userAppOrigin)
            return
        }
        if (typeof event.data !== "string") return
        listener?.(event.data)
    }
    return {
        prepare() {},
        close() {
            options.frame.src = "about:blank"
        },
        onUrl(nextListener) {
            listener = nextListener
            host.addEventListener("message", handleMessage)
            return () => {
                listener = null
                host.removeEventListener("message", handleMessage)
            }
        },
        async openUrl(requestUrl) {
            const queryIndex = requestUrl.indexOf("?")
            if (queryIndex === -1) throw new Error("browser link request is missing its encoded query")
            const destination = new URL(userAppUrl)
            destination.search = requestUrl.slice(queryIndex)
            options.frame.src = destination.toString()
        }
    }
}

/** Reads the private demo key from a pairing fragment or asks the operator once per tab. */
export function browserSessionKey(serviceUrl: string, host: Window = window, fragmentKey = "relayKey"): string {
    const storageKey = `coordination-session-key:${fragmentKey}:${new URL(serviceUrl).origin}`
    const current = new URL(host.location.href)
    const fragment = new URLSearchParams(current.hash.slice(1))
    const paired = fragment.get(fragmentKey)
    if (paired !== null) {
        fragment.delete(fragmentKey)
        current.hash = fragment.toString()
        host.history.replaceState(null, "", current.toString())
    }
    const token =
        paired ??
        host.sessionStorage.getItem(storageKey) ??
        host.prompt(fragmentKey === "memberKey" ? "Member connection key" : "Demo connection key")?.trim()
    if (!token || !/^[0-9a-f]{64}$/i.test(token)) throw new Error("A demo connection key is required")
    host.sessionStorage.setItem(storageKey, token)
    return token
}

export interface RelayWebLinkTransportOptions {
    /** Private key for this demo relay session; never put it in stack.json. */
    token: string
    relayUrl: string
    sender: string
    pollIntervalMs?: number
    fetcher?: typeof fetch
}

/** Carries unchanged link URLs through the local demo relay between independently opened pages. */
export function createRelayWebLinkTransport(
    options: RelayWebLinkTransportOptions
): Pick<LinkClientOptions, "openUrl" | "onUrl"> {
    const fetcher = options.fetcher ?? fetch
    const relayUrl = new URL(options.relayUrl).origin
    const headers = { authorization: `Bearer ${options.token}` }
    let after = 0
    return {
        async openUrl(url) {
            const response = await fetcher(`${relayUrl}/v1/requests`, {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify({ sender: options.sender, url })
            })
            if (!response.ok) throw new Error("wallet request could not be delivered")
        },
        onUrl(listener) {
            let active = true
            let polling = false
            const poll = async () => {
                if (!active || polling) return
                polling = true
                try {
                    const response = await fetcher(
                        `${relayUrl}/v1/responses?sender=${encodeURIComponent(options.sender)}&after=${after}`,
                        { headers }
                    )
                    if (!response.ok) return
                    const messages = (await response.json()) as Array<{ seq: number; url: string }>
                    for (const message of messages) {
                        after = Math.max(after, message.seq)
                        listener(message.url)
                    }
                    if (messages.length > 0) {
                        await fetcher(
                            `${relayUrl}/v1/responses?sender=${encodeURIComponent(options.sender)}&after=${after}`,
                            { method: "DELETE", headers }
                        )
                    }
                } catch {
                    // The next poll retries while the local demo stack starts or restarts.
                } finally {
                    polling = false
                }
            }
            void poll()
            const timer = setInterval(() => void poll(), options.pollIntervalMs ?? 500)
            return () => {
                active = false
                clearInterval(timer)
            }
        }
    }
}
