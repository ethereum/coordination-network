import assert from "node:assert/strict"
import { createServer, request as httpRequest, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { startRpcProxy } from "./rpc-proxy"

interface FakeUpstream {
    url: string
    received: { method: string | undefined; contentType: string | undefined; body: string }[]
    close(): Promise<void>
}

async function startUpstream(reply: { status: number; body: string; contentType?: string }): Promise<FakeUpstream> {
    const received: FakeUpstream["received"] = []
    const server: Server = createServer((request, response) => {
        const chunks: Buffer[] = []
        request.on("data", (chunk: Buffer) => chunks.push(chunk))
        request.on("end", () => {
            received.push({
                method: request.method,
                contentType: request.headers["content-type"],
                body: Buffer.concat(chunks).toString("utf8")
            })
            response.writeHead(reply.status, { "content-type": reply.contentType ?? "application/json" })
            response.end(reply.body)
        })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        received,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

test("the proxy forwards a JSON-RPC POST upstream and answers with the upstream's body", async () => {
    const upstream = await startUpstream({ status: 200, body: '{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}' })
    const proxy = await startRpcProxy({ upstream: upstream.url, host: "127.0.0.1", port: 0 })
    try {
        const request = '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
        const response = await fetch(proxy.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: request
        })

        assert.equal(response.status, 200)
        assert.equal(await response.text(), '{"jsonrpc":"2.0","id":1,"result":"0xaa36a7"}')
        assert.deepEqual(upstream.received, [{ method: "POST", contentType: "application/json", body: request }])
    } finally {
        await proxy.close()
        await upstream.close()
    }
})

test("the proxy hands back the upstream's error status and body unchanged", async () => {
    const upstream = await startUpstream({ status: 429, body: '{"error":"rate limited"}' })
    const proxy = await startRpcProxy({ upstream: upstream.url, host: "127.0.0.1", port: 0 })
    try {
        const response = await fetch(proxy.url, { method: "POST", body: "{}" })

        assert.equal(response.status, 429)
        assert.equal(await response.text(), '{"error":"rate limited"}')
    } finally {
        await proxy.close()
        await upstream.close()
    }
})

test("the proxy refuses every method but POST, without calling upstream", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" })
    const proxy = await startRpcProxy({ upstream: upstream.url, host: "127.0.0.1", port: 0 })
    try {
        for (const method of ["GET", "PUT", "DELETE"]) {
            const response = await fetch(proxy.url, { method })
            assert.equal(response.status, 405, method)
        }
        assert.deepEqual(upstream.received, [])
    } finally {
        await proxy.close()
        await upstream.close()
    }
})

test("the proxy answers 502 when the upstream cannot be reached", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" })
    const unreachable = upstream.url
    await upstream.close()
    const proxy = await startRpcProxy({ upstream: unreachable, host: "127.0.0.1", port: 0 })
    try {
        const response = await fetch(proxy.url, { method: "POST", body: "{}" })

        assert.equal(response.status, 502)
    } finally {
        await proxy.close()
    }
})

test("the proxy reports why a forward failed, with the upstream's keyed path cut and its cause code kept", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" })
    const unreachable = `${upstream.url}/v2/SECRETKEY?apikey=SECRETKEY`
    await upstream.close()
    const reported: string[] = []
    const proxy = await startRpcProxy({
        upstream: unreachable,
        host: "127.0.0.1",
        port: 0,
        onUpstreamError: (message) => reported.push(message)
    })
    try {
        const response = await fetch(proxy.url, { method: "POST", body: '{"secret":"REQUESTBODY"}' })

        assert.equal(response.status, 502)
        assert.equal(reported.length, 1)
        assert.match(reported[0], /ECONNREFUSED/)
        assert.ok(!/SECRETKEY|REQUESTBODY/.test(reported[0]), reported[0])
    } finally {
        await proxy.close()
    }
})

test("the proxy reports a provider's refusal once within the window, by status and never its body", async () => {
    const upstream = await startUpstream({ status: 429, body: '{"error":"PROVIDERBODY"}' })
    const reported: string[] = []
    const proxy = await startRpcProxy({
        upstream: upstream.url,
        host: "127.0.0.1",
        port: 0,
        onUpstreamError: (message) => reported.push(message)
    })
    try {
        for (let call = 0; call < 3; call++) {
            const response = await fetch(proxy.url, { method: "POST", body: "{}" })
            assert.equal(response.status, 429)
        }

        assert.deepEqual(reported, ["upstream answered 429"])
    } finally {
        await proxy.close()
        await upstream.close()
    }
})

test("the proxy refuses a request body over 1 MiB", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" })
    const proxy = await startRpcProxy({ upstream: upstream.url, host: "127.0.0.1", port: 0 })
    try {
        const response = await fetch(proxy.url, { method: "POST", body: "x".repeat(1024 * 1024 + 1) })

        assert.equal(response.status, 413)
        assert.deepEqual(upstream.received, [])
    } finally {
        await proxy.close()
        await upstream.close()
    }
})

test("close stops the proxy listening", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" })
    const proxy = await startRpcProxy({ upstream: upstream.url, host: "127.0.0.1", port: 0 })
    await proxy.close()
    try {
        await assert.rejects(fetch(proxy.url, { method: "POST", body: "{}" }))
    } finally {
        await upstream.close()
    }
})

test("the proxy passes the upstream's content type through", async () => {
    const upstream = await startUpstream({ status: 502, body: "bad gateway", contentType: "text/plain" })
    const proxy = await startRpcProxy({ upstream: upstream.url, host: "127.0.0.1", port: 0 })
    try {
        const response = await fetch(proxy.url, { method: "POST", body: "{}" })

        assert.equal(response.status, 502)
        assert.equal(response.headers.get("content-type"), "text/plain")
        assert.equal(await response.text(), "bad gateway")
    } finally {
        await proxy.close()
        await upstream.close()
    }
})

test("the proxy answers 502 when the upstream drops the connection mid-request", async () => {
    const server = createServer((request) => request.socket.destroy())
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const proxy = await startRpcProxy({
        upstream: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        host: "127.0.0.1",
        port: 0
    })
    try {
        const response = await fetch(proxy.url, { method: "POST", body: "{}" })

        assert.equal(response.status, 502)
        assert.match(await response.text(), /upstream RPC did not answer/)
    } finally {
        await proxy.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
})

test("the proxy's refusal of an oversized body reaches a client that is still uploading", async () => {
    const upstream = await startUpstream({ status: 200, body: "{}" })
    const proxy = await startRpcProxy({ upstream: upstream.url, host: "127.0.0.1", port: 0 })
    try {
        const chunk = Buffer.alloc(64 * 1024, "x")
        const status = await new Promise<number>((resolve, reject) => {
            const request = httpRequest(proxy.url, { method: "POST" }, (response) => {
                response.resume()
                resolve(response.statusCode ?? 0)
            })
            request.on("error", reject)
            let sent = 0
            const write = () => {
                while (sent < 16 * 1024 * 1024) {
                    sent += chunk.length
                    if (!request.write(chunk)) return void request.once("drain", write)
                }
                request.end()
            }
            write()
        })

        assert.equal(status, 413)
        assert.deepEqual(upstream.received, [])
    } finally {
        await proxy.close()
        await upstream.close()
    }
})

test("close ends a request that is waiting on the upstream instead of waiting for it", async () => {
    const hanging = createServer(() => {})
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", () => resolve()))
    const arrived = new Promise<void>((resolve) => hanging.once("request", () => resolve()))
    const proxy = await startRpcProxy({
        upstream: `http://127.0.0.1:${(hanging.address() as AddressInfo).port}`,
        host: "127.0.0.1",
        port: 0
    })
    try {
        const inFlight = fetch(proxy.url, { method: "POST", body: "{}" }).then(
            () => "answered",
            () => "dropped"
        )
        await arrived

        const closed = await Promise.race([
            proxy.close().then(() => "closed"),
            new Promise<string>((resolve) => setTimeout(() => resolve("still open"), 2000))
        ])

        assert.equal(closed, "closed")
        assert.equal(await inFlight, "dropped")
    } finally {
        hanging.closeAllConnections()
        await new Promise<void>((resolve) => hanging.close(() => resolve()))
    }
})

test("the proxy survives an upstream that drops mid-body, without an unhandled rejection", async () => {
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on("unhandledRejection", onRejection)
    const upstream: Server = createServer((request, response) => {
        request.resume()
        request.on("end", () => {
            response.writeHead(200, { "content-type": "application/json", "content-length": "100" })
            response.write("partial")
            setTimeout(() => response.socket?.destroy(), 10)
        })
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()))
    const proxy = await startRpcProxy({
        upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
        host: "127.0.0.1",
        port: 0
    })
    try {
        await fetch(proxy.url, { method: "POST", body: "{}" }).then(
            (response) => response.text(),
            () => undefined
        )
        await new Promise((resolve) => setTimeout(resolve, 50))

        assert.deepEqual(rejections, [])
        const after = await fetch(proxy.url, { method: "GET" })
        assert.equal(after.status, 405, "the proxy still answers")
    } finally {
        process.off("unhandledRejection", onRejection)
        await proxy.close()
        await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
})
