import type { Server } from "node:http"
import express from "express"
import type { Address, Hex } from "viem"
import { config } from "../../src/config.ts"
import { createRoutes } from "../../src/routes.ts"
import { announcement, key1 } from "../utils/fixtures.ts"
import type { Store } from "../../src/store.ts"
import { AnnouncementScanStatus, RegisteredKey } from "../../src/types.ts"

// balances come from the chain, not the store, so this is the one collaborator left to fake
jest.mock("../../src/fetchBalances.ts", () => ({ fetchBalances: jest.fn(async () => []) }))

const storedAccounts: Array<{ id: bigint; stealthAddress: Address; ephemeralPublicKey: Hex }> = []
let lowestScannedBlockResult: bigint | null = null
let registeredKeyCount = 1
let keysPassedToStore: Array<RegisteredKey> = []
let deletedKeyCount = 1
let networkIdPassedToStore: Hex | null = null

const store: Store = {
    listAccounts: async ({ limit }) => storedAccounts.slice(0, limit),
    lowestScannedBlock: async () => lowestScannedBlockResult,
    registerKeys: async (keys) => {
        keysPassedToStore = keys
        return registeredKeyCount
    },
    deleteKeys: async (networkId) => {
        networkIdPassedToStore = networkId
        return deletedKeyCount
    },
    listKeys: async () => [],
    saveScanResult: async () => {}
}

let listener: Server
let url: string
let announcementScanStatus: AnnouncementScanStatus

const authorization = { authorization: `Bearer ${process.env.AUTH_TOKEN}` }

const postHeaders = { ...authorization, "content-type": "application/json" }

function storeAccounts(count: number) {
    for (let logIndex = 0; logIndex < count; logIndex += 1) {
        storedAccounts.push({
            id: BigInt(logIndex + 1),
            stealthAddress: announcement(logIndex).stealthAddress,
            ephemeralPublicKey: announcement(logIndex).ephemeralPublicKey
        })
    }
}

beforeAll(() => {
    announcementScanStatus = {
        latestBlock: 100n,
        blockScanWindowSize: 2000,
        scanning: false,
        lastScanAt: null,
        lastError: null
    }

    const app = express()
    app.use(createRoutes(store, announcementScanStatus))
    listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    url = `http://127.0.0.1:${port}`
})

afterAll(() => {
    listener.close()
})

beforeEach(() => {
    storedAccounts.length = 0
    lowestScannedBlockResult = null
    registeredKeyCount = 1
    keysPassedToStore = []
    deletedKeyCount = 1
    networkIdPassedToStore = null
    announcementScanStatus.latestBlock = 100n
    announcementScanStatus.lastScanAt = null
    announcementScanStatus.lastError = null
})

// every route is behind the token, including /health, which is conventionally public
for (const path of ["/keys", "/accounts", "/balances", "/health"]) {
    test(`${path} is rejected without a token`, async () => {
        const response = await fetch(`${url}${path}`)

        expect(response.status).toBe(401)
    })
}

test("POST /keys rejects a body that is not JSON", async () => {
    const response = await fetch(`${url}/keys`, { method: "POST", headers: postHeaders, body: "{" })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "body must be JSON" })
})

test("POST /keys rejects a body with a missing field", async () => {
    const response = await fetch(`${url}/keys`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({ networkId: key1.networkId, spendingPublicKey: key1.spendingPublicKey })
    })

    expect(response.status).toBe(400)
})

test("POST /keys rejects a key that is not hex of the right length", async () => {
    const response = await fetch(`${url}/keys`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({ ...key1, viewingPrivateKey: `0x${"zz".repeat(32)}`, fromBlock: 0 })
    })

    expect(response.status).toBe(400)
})

test("POST /keys reports a key that was already registered as unchanged", async () => {
    registeredKeyCount = 0

    const response = await fetch(`${url}/keys`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({ ...key1, fromBlock: 0 })
    })

    // the caller must not read this as a fresh fromBlock taking effect
    expect(response.status).toBe(409)
})

test("POST /keys registers a key the scan loop then picks up", async () => {
    const response = await fetch(`${url}/keys`, {
        method: "POST",
        headers: postHeaders,
        body: JSON.stringify({ ...key1, fromBlock: 10 })
    })

    expect(response.status).toBe(201)
    // fromBlock is the first block to scan, so the stored bookmark sits one behind it
    expect(keysPassedToStore).toEqual([{ ...key1, scannedUntilBlock: 9n }])
})

test("GET /accounts returns the discovered accounts", async () => {
    storeAccounts(1)

    const body = await (await fetch(`${url}/accounts?networkId=${key1.networkId}`, { headers: authorization })).json()

    expect(body.accounts).toEqual([
        {
            stealthAddress: announcement(0).stealthAddress,
            ephemeralPublicKey: announcement(0).ephemeralPublicKey
        }
    ])
})

test("GET /accounts rejects a malformed networkId", async () => {
    const response = await fetch(`${url}/accounts?networkId=0x1234`, { headers: authorization })
    expect(response.status).toBe(400)
})

test("GET /accounts rejects a request that names no entity", async () => {
    const response = await fetch(`${url}/accounts`, { headers: authorization })
    // no caller should be able to list every entity by omitting a parameter
    expect(response.status).toBe(400)
})

test("GET /balances rejects a request that names no entity", async () => {
    const response = await fetch(`${url}/balances?tokenIds=0`, { headers: authorization })
    expect(response.status).toBe(400)
})

test("GET /balances rejects a request that names no token types", async () => {
    const response = await fetch(`${url}/balances?networkId=${key1.networkId}`, { headers: authorization })
    // a member issues many token ids, so the caller must say which
    expect(response.status).toBe(400)
})

test("GET /balances rejects a token id that is not a number", async () => {
    const response = await fetch(`${url}/balances?networkId=${key1.networkId}&tokenIds=0&tokenIds=abc`, {
        headers: authorization
    })
    expect(response.status).toBe(400)
})

test("GET /balances answers an entity with no accounts", async () => {
    const response = await fetch(`${url}/balances?networkId=${key1.networkId}&tokenIds=0`, { headers: authorization })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ balances: [], nextCursor: null })
})

test("GET /accounts rejects a limit outside 1-1000", async () => {
    const response = await fetch(`${url}/accounts?networkId=${key1.networkId}&limit=0`, { headers: authorization })
    expect(response.status).toBe(400)
})

test("GET /accounts rejects a negative cursor", async () => {
    const response = await fetch(`${url}/accounts?networkId=${key1.networkId}&after=-1`, { headers: authorization })
    expect(response.status).toBe(400)
})

test("GET /accounts sets nextCursor when the page is full", async () => {
    storeAccounts(3)

    const body = await (
        await fetch(`${url}/accounts?networkId=${key1.networkId}&limit=2`, { headers: authorization })
    ).json()

    expect(body.accounts).toHaveLength(2)
    // a full page implies more might follow
    expect(body.nextCursor).not.toBeNull()
})

test("GET /accounts returns a null nextCursor when the page is short", async () => {
    storeAccounts(1)

    const body = await (
        await fetch(`${url}/accounts?networkId=${key1.networkId}&limit=100`, { headers: authorization })
    ).json()

    // a page shorter than the limit is the last one
    expect(body.nextCursor).toBeNull()
})

test("GET /health counts a key registered since the last scan towards the lag", async () => {
    // a key registered after the scan that set latestBlock has scanned nothing yet
    lowestScannedBlockResult = 0n
    announcementScanStatus.latestBlock = 100n

    const health = await (await fetch(`${url}/health`, { headers: authorization })).json()

    expect(health.lowestScannedBlock).toBe("0")
    expect(health.lagBlocks).toBe("100")
})

test("GET /health reports no lag before the first scan sets the latest block", async () => {
    // before the first scan sets latestBlock, or while the RPC is down, the
    // stored bookmark is ahead of the scan ceiling and the lag goes negative
    lowestScannedBlockResult = 100n
    announcementScanStatus.latestBlock = 0n

    const health = await (await fetch(`${url}/health`, { headers: authorization })).json()

    expect(health.lagBlocks).toBe("0")
})

test("GET /health returns the current scan progress", async () => {
    lowestScannedBlockResult = 90n
    announcementScanStatus.latestBlock = 100n
    announcementScanStatus.lastScanAt = "2026-01-01T00:00:00.000Z"

    const health = await (await fetch(`${url}/health`, { headers: authorization })).json()

    expect(health).toEqual({
        latestBlock: "100",
        lowestScannedBlock: "90",
        lagBlocks: "10",
        lastScanAt: "2026-01-01T00:00:00.000Z",
        lastError: null
    })
})

test("GET /health strips the provider URL from a scan error", async () => {
    lowestScannedBlockResult = 90n
    announcementScanStatus.lastError = `HTTP request failed.\n\nURL: ${config.rpcUrl}\nRequest body: {}`

    const health = await (await fetch(`${url}/health`, { headers: authorization })).json()

    expect(health.lastError).not.toContain(config.rpcUrl)
})

test("DELETE /keys rejects a malformed networkId", async () => {
    const shortNetworkId = "0x1234"
    const response = await fetch(`${url}/keys/${shortNetworkId}`, { method: "DELETE", headers: authorization })

    expect(response.status).toBe(400)
})

test("DELETE /keys reports an entity with no keys as not found", async () => {
    deletedKeyCount = 0

    const response = await fetch(`${url}/keys/${key1.networkId}`, { method: "DELETE", headers: authorization })

    expect(response.status).toBe(404)
})

test("DELETE /keys deletes the entity's keys", async () => {
    const response = await fetch(`${url}/keys/${key1.networkId}`, { method: "DELETE", headers: authorization })

    expect(response.status).toBe(204)
    expect(networkIdPassedToStore).toBe(key1.networkId)
})
