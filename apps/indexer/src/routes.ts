import express, { type NextFunction, type Request, type Response } from "express"
import { z } from "zod"
import { requireAuthToken } from "./auth.ts"
import { config, hex } from "./config.ts"
import { fetchBalances } from "./fetchBalances.ts"
import { logger } from "./logger.ts"
import { createHttpRequestLog } from "./requestLog.ts"
import type { Store } from "./store.ts"
import { AnnouncementScanStatus } from "./types.ts"

const accountsQuerySchema = z.object({
    networkId: hex(32),
    limit: z.coerce.number().int().positive().max(1000).default(100),
    after: z.coerce.bigint().nonnegative().default(0n)
})

// a member issues one token id per scoped token type
const MAX_TOKEN_IDS = 50
const balancesQuerySchema = accountsQuerySchema.extend({
    // one parameter per token type, repeated: ?tokenIds=0&tokenIds=1. Express hands over a
    // single one as a string rather than a list, so it is wrapped before validating
    tokenIds: z.preprocess(
        (tokenIds) => (Array.isArray(tokenIds) ? tokenIds : [tokenIds]),
        z.array(z.coerce.bigint().nonnegative()).min(1).max(MAX_TOKEN_IDS)
    )
})

const accountsQueryError = "networkId must be 32 hex bytes, limit must be 1-1000, after must be a non-negative integer"
const balancesQueryError = `${accountsQueryError}, tokenIds must be 1-${MAX_TOKEN_IDS} non-negative integers`

/**
 * A page shorter than the pagination limit is the last one, so there is no cursor to carry on from.
 * Asking for 100 of an entity's 250 accounts: the first two pages are full and hand back the id to
 * resume at, the third holds 50 and hands back null.
 */
function nextCursorFor(accountsPage: Array<{ id: bigint }>, pageLimit: number): string | null {
    if (accountsPage.length < pageLimit) return null
    return accountsPage[accountsPage.length - 1].id.toString()
}

/** fromBlock is the first block to scan for this key: the chain head for a fresh key, earlier for a handed-over one. */
const registerKeyBodySchema = z.object({
    networkId: hex(32),
    spendingPublicKey: hex(33),
    viewingPrivateKey: hex(32),
    fromBlock: z.coerce.bigint().nonnegative()
})

/** The /keys, /accounts, /balances and /health routes. */
export function createRoutes(store: Store, announcementScanStatus: AnnouncementScanStatus) {
    const routes = express.Router()
    routes.use(createHttpRequestLog(logger))
    routes.use(requireAuthToken)
    routes.use(express.json())

    routes.post("/keys", async (request, response) => {
        // the body carries a private key, so no intermediary should hold on to this exchange
        response.set("Cache-Control", "no-store")

        const registerKeyBody = registerKeyBodySchema.safeParse(request.body)
        if (!registerKeyBody.success) {
            response.status(400).json({ error: "networkId, spendingPublicKey, viewingPrivateKey, fromBlock required" })
            return
        }

        const { networkId, spendingPublicKey, viewingPrivateKey, fromBlock } = registerKeyBody.data
        const registeredCount = await store.registerKeys([
            { networkId, spendingPublicKey, viewingPrivateKey, scannedUntilBlock: fromBlock - 1n }
        ])
        if (registeredCount === 0) {
            response.status(409).json({ error: "spendingPublicKey already registered" })
            return
        }
        response.status(201).end()
    })

    routes.get("/accounts", async (request, response) => {
        response.set("Cache-Control", "no-store")

        const query = accountsQuerySchema.safeParse(request.query)
        if (!query.success) {
            response.status(400).json({ error: accountsQueryError })
            return
        }

        const accountsPage = await store.listAccounts(query.data)

        response.json({
            accounts: accountsPage.map((account) => ({
                stealthAddress: account.stealthAddress,
                ephemeralPublicKey: account.ephemeralPublicKey
            })),
            nextCursor: nextCursorFor(accountsPage, query.data.limit)
        })
    })

    routes.get("/balances", async (request, response) => {
        response.set("Cache-Control", "no-store")

        const query = balancesQuerySchema.safeParse(request.query)
        if (!query.success) {
            response.status(400).json({ error: balancesQueryError })
            return
        }

        const accountsPage = await store.listAccounts(query.data)
        const balances = await fetchBalances(
            accountsPage.map((account) => account.stealthAddress),
            query.data.tokenIds
        )

        response.json({
            balances: balances.map((balance) => ({
                stealthAddress: balance.stealthAddress,
                tokenId: balance.tokenId.toString(),
                balance: balance.balance.toString()
            })),
            nextCursor: nextCursorFor(accountsPage, query.data.limit)
        })
    })

    routes.get("/health", async (_request, response) => {
        // read from the database, so a key registered since the last scan counts towards the lag straight away
        const scannedBlock = (await store.lowestScannedBlock()) ?? config.startBlock - 1n
        const scanUntilBlock = announcementScanStatus.latestBlock - BigInt(config.confirmations)
        const lagBlocks = scanUntilBlock - scannedBlock
        response.json({
            latestBlock: announcementScanStatus.latestBlock.toString(),
            lowestScannedBlock: scannedBlock.toString(),
            lagBlocks: (lagBlocks > 0n ? lagBlocks : 0n).toString(),
            lastScanAt: announcementScanStatus.lastScanAt,
            lastError:
                announcementScanStatus.lastError &&
                announcementScanStatus.lastError.split(config.rpcUrl).join("<rpc url>")
        })
    })

    routes.delete("/keys/:networkId", async (request, response) => {
        const networkId = hex(32).safeParse(request.params.networkId)
        if (!networkId.success) {
            response.status(400).json({ error: "networkId must be 32 hex bytes" })
            return
        }

        const deletedCount = await store.deleteKeys(networkId.data)
        if (deletedCount === 0) {
            response.status(404).json({ error: "no keys registered for networkId" })
            return
        }
        response.status(204).end()
    })

    // Middleware function for every route. Returns bad request on malformed json, or
    // internal server error on anything else. Default express responses return a stack
    // trace, or the text that failed to parse, which on POST /keys is the private key.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    routes.use((error: Error, _request: Request, response: Response, _next: NextFunction) => {
        if (error instanceof SyntaxError) {
            response.status(400).json({ error: "body must be JSON" })
            return
        }
        logger.error({ err: error }, "request failed")
        response.status(500).json({ error: "internal error" })
    })

    return routes
}
