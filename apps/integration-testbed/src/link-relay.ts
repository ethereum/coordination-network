import { createServer, type IncomingMessage, type Server } from "node:http"
import { timingSafeEqual, randomUUID } from "node:crypto"
import { refuseForeignHost } from "./host-guard"

interface Message {
    seq: number
    sender: string
    url: string
    expiresAt: number
}

export interface LinkRelayOptions {
    /** Random 32-byte session key, shared privately with the demo's browser tabs. */
    token: string
    host?: string
    maxBodyBytes?: number
    maxMessages?: number
    messageTtlMs?: number
    now?: () => number
}

function hasToken(header: string | undefined, token: string): boolean {
    const supplied = Buffer.from(/^Bearer (.+)$/.exec(header ?? "")?.[1] ?? "")
    const expected = Buffer.from(token)
    return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

function identifier(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 256
}

async function readBody(request: IncomingMessage, limit: number): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        request.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size > limit) {
                chunks.length = 0
                resolve(undefined)
            } else chunks.push(chunk)
        })
        request.once("end", () => resolve(size > limit ? undefined : Buffer.concat(chunks).toString("utf8")))
        request.once("error", reject)
    })
}

export function startLinkRelay(
    port: number,
    allowedOrigins: readonly string[],
    {
        token,
        host = "127.0.0.1",
        maxBodyBytes = 16 * 1024,
        maxMessages = 100,
        messageTtlMs = 300_000,
        now = Date.now
    }: LinkRelayOptions
): Promise<Server> {
    if (!/^[0-9a-f]{64}$/i.test(token)) throw new Error("relay token must be a random 32-byte hex key")
    for (const limit of [maxBodyBytes, maxMessages, messageTtlMs]) {
        if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("relay limits must be positive integers")
    }
    const instanceId = randomUUID()
    let sequence = 0
    let requests: Message[] = []
    let responses: Message[] = []
    const consumers = new Map<string, { id: string; expiresAt: number }>()
    const prune = () => {
        const time = now()
        requests = requests.filter(({ expiresAt }) => expiresAt > time)
        responses = responses.filter(({ expiresAt }) => expiresAt > time)
        for (const [sender, claim] of consumers) if (claim.expiresAt <= time) consumers.delete(sender)
    }
    const timer = setInterval(prune, Math.min(messageTtlMs, 30_000))
    timer.unref()
    const server = createServer((request, response) => {
        const send = (status: number, body: unknown) => {
            response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body))
        }
        response.setHeader("cache-control", "no-store")
        response.setHeader("vary", "origin")
        if (refuseForeignHost(request, response)) return
        const origin = request.headers.origin
        if (origin && !allowedOrigins.includes(origin)) {
            request.resume()
            send(403, { error: "origin not allowed" })
            return
        }
        if (origin) response.setHeader("access-control-allow-origin", origin)
        if (request.method === "OPTIONS") {
            response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS")
            response.setHeader("access-control-allow-headers", "content-type, authorization")
            response.writeHead(204).end()
            return
        }
        let url: URL
        try {
            url = new URL(request.url ?? "/", "http://localhost")
        } catch {
            request.resume()
            send(400, { error: "invalid URL" })
            return
        }
        if (request.method === "GET" && url.pathname === "/health") {
            send(200, { ok: true, name: "User app link relay", instanceId, latestSequence: sequence })
            return
        }
        if (!hasToken(request.headers.authorization, token)) {
            request.resume()
            send(401, { error: "relay session key required" })
            return
        }
        prune()
        const kind =
            url.pathname === "/v1/requests" ? "requests" : url.pathname === "/v1/responses" ? "responses" : null
        if (kind === null) {
            request.resume()
            send(404, { error: "not found" })
            return
        }
        if (request.method === "GET" || request.method === "DELETE") {
            const after = Number(url.searchParams.get("after") ?? 0)
            const sender = url.searchParams.get("sender")
            const consumer = url.searchParams.get("consumer")
            if (
                !Number.isSafeInteger(after) ||
                after < 0 ||
                (kind === "requests" ? !identifier(consumer) : !identifier(sender))
            ) {
                send(400, { error: "invalid cursor or recipient" })
                return
            }
            // A cursor acknowledges receipt, only for this recipient. Unacknowledged messages
            // remain available after a dropped poll response, until their expiry.
            if (kind === "requests") {
                requests = requests.filter(
                    (message) => message.seq > after || consumers.get(message.sender)?.id !== consumer
                )
            } else responses = responses.filter((message) => message.seq > after || message.sender !== sender)
            if (request.method === "DELETE") {
                send(200, { ok: true })
                return
            }
            const source = kind === "requests" ? requests : responses
            const messages = source.filter((message) => {
                if (message.seq <= after) return false
                if (kind === "responses") return message.sender === sender
                let claim = consumers.get(message.sender)
                if (!claim) {
                    if (consumers.size >= maxMessages) return false
                    claim = { id: consumer!, expiresAt: now() + messageTtlMs }
                    consumers.set(message.sender, claim)
                }
                return claim.id === consumer
            })
            send(
                200,
                messages.map(({ seq, sender, url }) => ({ seq, sender, url }))
            )
            return
        }
        if (request.method !== "POST") {
            request.resume()
            send(405, { error: "method not allowed" })
            return
        }
        if ((request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase() !== "application/json") {
            request.resume()
            send(415, { error: "JSON required" })
            return
        }
        void readBody(request, maxBodyBytes)
            .then((body) => {
                if (body === undefined) return send(413, { error: "message too large" })
                let value: { sender?: unknown; url?: unknown; consumer?: unknown }
                try {
                    value = JSON.parse(body)
                    if (
                        !value ||
                        !identifier(value.sender) ||
                        typeof value.url !== "string" ||
                        !value.url ||
                        value.url.length > 2000
                    )
                        throw new Error()
                } catch {
                    send(400, { error: "invalid message" })
                    return
                }
                prune()
                if (
                    kind === "responses" &&
                    (!identifier(value.consumer) || consumers.get(value.sender as string)?.id !== value.consumer)
                ) {
                    send(403, { error: "request belongs to another wallet" })
                    return
                }
                if ((kind === "requests" ? requests : responses).length >= maxMessages) {
                    send(429, { error: "relay queue is full" })
                    return
                }
                const message: Message = {
                    seq: ++sequence,
                    sender: value.sender as string,
                    url: value.url as string,
                    expiresAt: now() + messageTtlMs
                }
                ;(kind === "requests" ? requests : responses).push(message)
                send(200, { seq: message.seq })
            })
            .catch(() => {
                if (!response.headersSent) send(400, { error: "invalid message" })
            })
    })
    server.requestTimeout = 30_000
    server.headersTimeout = 15_000
    server.once("close", () => clearInterval(timer))
    return new Promise((resolve, reject) => {
        server.once("error", (error) => {
            clearInterval(timer)
            reject(error)
        })
        server.listen(port, host, () => resolve(server))
    })
}
