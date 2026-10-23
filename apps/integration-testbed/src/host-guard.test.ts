import assert from "node:assert/strict"
import { request as httpRequest } from "node:http"
import { test } from "node:test"
import { startDashboard } from "./dashboard"
import { isAllowedHost } from "./host-guard"
import { startRpcProxy } from "./rpc-proxy"
import type { StackDescriptor } from "./serve"

test("isAllowedHost accepts IP literals and localhost, with or without a port", () => {
    for (const host of [
        "127.0.0.1",
        "127.0.0.1:8080",
        "192.168.1.20:8545",
        "localhost",
        "localhost:8080",
        "LOCALHOST:3001",
        "[::1]",
        "[::1]:8080"
    ]) {
        assert.equal(isAllowedHost(host), true, host)
    }
})

test("isAllowedHost refuses a DNS name, a missing header and lookalikes", () => {
    for (const host of [
        undefined,
        "",
        "evil.example",
        "evil.example:8080",
        "127.0.0.1.evil.example",
        "localhost.evil.example",
        "127.0.0.1:80:80",
        "user@127.0.0.1"
    ]) {
        assert.equal(isAllowedHost(host), false, String(host))
    }
})

/** A request with exactly this Host header: fetch will not let a caller set one. */
function get(url: string, host: string, method = "GET", path = "/"): Promise<number> {
    const { port } = new URL(url)
    return new Promise((resolve, reject) => {
        const request = httpRequest(
            { host: "127.0.0.1", port, method, path, headers: { host, connection: "close" } },
            (response) => {
                response.resume()
                response.on("end", () => resolve(response.statusCode ?? 0))
            }
        )
        request.once("error", reject)
        request.end("{}")
    })
}

const STACK = { members: [], dashboardUrl: "http://127.0.0.1:0" } as unknown as StackDescriptor

test("the RPC proxy answers 421 to a foreign Host and forwards an IP or localhost one", async () => {
    const proxy = await startRpcProxy({ upstream: "http://127.0.0.1:1", host: "127.0.0.1", port: 0 })
    try {
        assert.equal(await get(proxy.url, "evil.example", "POST"), 421)
        for (const host of ["127.0.0.1:8545", "192.168.1.20:8545", "localhost:8545"]) {
            // The upstream is unreachable, so an accepted Host reaches it and gets the proxy's 502.
            assert.equal(await get(proxy.url, host, "POST"), 502, host)
        }
    } finally {
        await proxy.close()
    }
})

test("the dashboard answers 421 to a foreign Host and serves an IP or localhost one", async () => {
    const dashboard = await startDashboard({
        stack: STACK,
        secrets: { dashboardKey: "d".repeat(64), memberServerTokens: {} },
        getState: async () => {
            throw new Error("not reached for the stack.json route")
        },
        host: "127.0.0.1",
        port: 0
    })
    try {
        assert.equal(await get(dashboard.url, "evil.example", "GET", "/stack.json"), 421)
        assert.equal(await get(dashboard.url, "evil.example:8080", "POST", "/api/orgs/0/admit"), 421)
        for (const host of ["127.0.0.1:8080", "192.168.1.20:8080", "localhost:8080"]) {
            assert.equal(await get(dashboard.url, host, "GET", "/stack.json"), 200, host)
        }
    } finally {
        await dashboard.close()
    }
})
