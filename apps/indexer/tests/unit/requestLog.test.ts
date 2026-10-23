import { Writable } from "node:stream"
import type { Server } from "node:http"
import express from "express"
import pino from "pino"
import { requireAuthToken } from "../../src/auth.ts"
import { config } from "../../src/config.ts"
import { createHttpRequestLog } from "../../src/requestLog.ts"
import { key1 } from "../utils/fixtures.ts"

const authToken = process.env.AUTH_TOKEN as string
const { networkId, viewingPrivateKey } = key1
const postHeaders = { authorization: `Bearer ${authToken}`, "content-type": "application/json" }

let listener: Server
let url: string
const logEntries: Array<Record<string, never> & { req: { url: string }; res: { statusCode: number } }> = []

beforeAll(() => {
    const capture = new Writable({
        write(chunk, _encoding, callback) {
            logEntries.push(JSON.parse(String(chunk)))
            callback()
        }
    })

    const app = express()
    // as the service does, so the logged address is the caller and not a proxy in front of it
    app.set("trust proxy", config.trustedProxyAddress)
    // the mounting order the service uses: log first, so a rejected caller is still recorded
    app.use(createHttpRequestLog(pino({ level: "info" }, capture)))
    app.use(requireAuthToken)
    app.use(express.json())
    app.post("/keys", (_request, response) => {
        response.status(201).json({ registered: true })
    })
    listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    url = `http://127.0.0.1:${port}`
})

afterAll(() => {
    listener.close()
})

beforeEach(() => {
    logEntries.length = 0
})

test("a rejected caller is logged, since a failed access attempt is the interesting one", async () => {
    await fetch(`${url}/keys`, { method: "POST", headers: { authorization: "Bearer wrong-token" } })

    expect(logEntries).toHaveLength(1)
    const [logEntry] = logEntries
    expect(logEntry.kind).toBe("access")
    expect(logEntry.res.statusCode).toBe(401)
    expect(logEntry.req.url).toBe("/keys")
})

test("an access entry records who called, from where, and whether it worked", async () => {
    await fetch(`${url}/keys`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({ networkId, viewingPrivateKey })
    })

    const [logEntry] = logEntries
    expect(logEntry.res.statusCode).toBe(201)
    expect(logEntry.networkId).toBe(networkId)
    // ${logEntry.clientIp} should be the caller
    expect(String(logEntry.clientIp).endsWith("127.0.0.1")).toBeTruthy()
    expect(typeof logEntry.responseTime).toBe("number")
})

test("an access entry carries neither the request body nor the auth token", async () => {
    await fetch(`${url}/keys`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({ networkId, viewingPrivateKey })
    })

    const serialised = JSON.stringify(logEntries[0])
    // a viewing private key must never reach the log
    expect(!serialised.includes(viewingPrivateKey)).toBeTruthy()
    // the auth token must never reach the log
    expect(!serialised.includes(authToken)).toBeTruthy()
})
