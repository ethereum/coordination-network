import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { refuseForeignHost } from "./host-guard"
import { redactUrls } from "./redact-urls"

const MAX_BODY_BYTES = 1024 * 1024
const STATUS_REPORT_INTERVAL_MS = 30_000

export interface RpcProxyOptions {
    upstream: string
    host: string
    port: number
    /** Told why a forward failed: the error's message cut to URL origins, and its cause's code. Also told
     *  of a non-2xx upstream status, by status alone and at most once per status every 30 s. */
    onUpstreamError?: (message: string) => void
}

export interface RpcProxy {
    url: string
    close(): Promise<void>
}

/** Resolves to the request body, or `undefined` once it passed the cap; the rest is drained so the
 *  refusal still reaches a client that is mid-upload. */
function readBody(request: IncomingMessage): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = []
        let size = 0
        request.on("data", (chunk: Buffer) => {
            size += chunk.length
            if (size <= MAX_BODY_BYTES) chunks.push(chunk)
        })
        request.on("end", () => resolve(size <= MAX_BODY_BYTES ? Buffer.concat(chunks).toString("utf8") : undefined))
        request.once("error", reject)
    })
}

function describeUpstreamError(error: Error): string {
    const cause = "cause" in error ? error.cause : undefined
    const code = cause instanceof Error && "code" in cause && typeof cause.code === "string" ? ` (${cause.code})` : ""
    return `${redactUrls(error.message)}${code}`
}

function refuse(response: ServerResponse, status: number, message: string): void {
    response.writeHead(status, { "content-type": "application/json" })
    response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }))
}

/**
 * Forwards JSON-RPC POSTs to a provider, so the phones reach the chain through this process and
 * the provider's API key stays in the stack's environment rather than in `stack.json`. Request and
 * response bodies are never logged, since they carry user operations and signed transactions.
 */
export async function startRpcProxy({ upstream, host, port, onUpstreamError }: RpcProxyOptions): Promise<RpcProxy> {
    const lastReported = new Map<number, number>()
    const reportStatus = (status: number) => {
        const now = Date.now()
        const last = lastReported.get(status)
        if (last !== undefined && now - last < STATUS_REPORT_INTERVAL_MS) return
        lastReported.set(status, now)
        onUpstreamError?.(`upstream answered ${status}`)
    }

    const server = createServer((request, response) => {
        if (refuseForeignHost(request, response)) return

        if (request.method !== "POST") {
            request.resume()
            refuse(response, 405, "JSON-RPC over POST only")
            return
        }

        readBody(request)
            .then(async (body) => {
                if (body === undefined) return refuse(response, 413, "request body too large")

                const forwarded = await fetch(upstream, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body
                })
                // Read in full before any header goes out, so a drop mid-body is still a 502.
                const answer = await forwarded.text()
                if (!forwarded.ok) reportStatus(forwarded.status)
                response.writeHead(forwarded.status, {
                    "content-type": forwarded.headers.get("content-type") ?? "application/json"
                })
                response.end(answer)
            })
            .catch((error: unknown) => {
                if (error instanceof Error) onUpstreamError?.(describeUpstreamError(error))
                if (response.headersSent) response.destroy()
                else refuse(response, 502, "the upstream RPC did not answer")
            })
    })

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(port, host, () => resolve())
    })

    return {
        url: `http://${host}:${(server.address() as AddressInfo).port}`,
        close: () =>
            new Promise<void>((resolve) => {
                server.close(() => resolve())
                server.closeAllConnections()
            })
    }
}
