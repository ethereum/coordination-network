import assert from "node:assert/strict"
import { once } from "node:events"
import { test } from "node:test"
import { InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import { buildServer } from "../src/server"

async function withServer(
    run: (url: string) => Promise<void>,
    allowedOrigins: string[] = ["http://localhost:4173"]
): Promise<void> {
    const resolver = new InMemoryResolver()
    const app = buildServer({
        issuerNetworkId: `0x${"aa".repeat(32)}`,
        signer: new LocalCredentialSigner("cors-test"),
        resolver,
        allowedOrigins
    })
    const server = app.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("server has no TCP address")
    try {
        await run(`http://127.0.0.1:${address.port}`)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

test("allows a configured browser origin and answers its preflight", async () => {
    await withServer(async (url) => {
        const response = await fetch(`${url}/v1/issuers`, { headers: { Origin: "http://localhost:4173" } })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:4173")

        const preflight = await fetch(`${url}/v1/verify`, {
            method: "OPTIONS",
            headers: { Origin: "http://localhost:4173" }
        })
        assert.equal(preflight.status, 204)
        assert.equal(preflight.headers.get("access-control-allow-headers"), "Content-Type, Authorization")
    })
})

test("refuses an unlisted browser origin", async () => {
    await withServer(async (url) => {
        const response = await fetch(`${url}/health`, { headers: { Origin: "http://localhost:9999" } })
        assert.equal(response.status, 403)
        assert.equal(response.headers.get("access-control-allow-origin"), null)
    })
})

test("allows non-browser requests with an Origin header when no allowlist is configured", async () => {
    await withServer(async (url) => {
        const response = await fetch(`${url}/health`, { headers: { Origin: "http://localhost:9999" } })
        assert.equal(response.status, 200)
        assert.equal(response.headers.get("access-control-allow-origin"), null)
    }, [])
})
