import { execFileSync } from "node:child_process"
import { once } from "node:events"
import type { Server as HttpServer } from "node:http"
import type { Address, Hex } from "viem"
import type { Chain } from "./anvil"
import { freePort } from "./anvil"
import type { StealthDeployment } from "./deployer"

const AUTH_TOKEN = `0x${"41".repeat(32)}`
const ENCRYPTION_KEY = `0x${"42".repeat(32)}`
const LOOKUP_HASH_KEY = `0x${"43".repeat(32)}`
const POSTGRES_IMAGE = "postgres:18-alpine"

type IndexerHealth = {
    latestBlock: string
    lowestScannedBlock: string
    lagBlocks: string
    lastScanAt: string | null
    lastError: string | null
}

export type IndexedAccount = {
    stealthAddress: Address
    ephemeralPublicKey: Hex
}

export type IndexedBalance = {
    stealthAddress: Address
    tokenId: string
    balance: string
}

export interface TestbedIndexer {
    url: string
    registerKey(input: {
        networkId: Hex
        spendingPublicKey: Hex
        viewingPrivateKey: Hex
        fromBlock: bigint
    }): Promise<void>
    accounts(networkId: Hex): Promise<IndexedAccount[]>
    balances(networkId: Hex, tokenIds: bigint[]): Promise<IndexedBalance[]>
    waitUntilScanned(blockNumber: bigint): Promise<IndexerHealth>
    stop(): Promise<void>
}

type PostgresContainer = {
    containerId: string
    databaseUrl: string
    stop(): void
}

async function startPostgres(): Promise<PostgresContainer> {
    const port = await freePort()
    const containerId = execFileSync(
        "docker",
        [
            "run",
            "--rm",
            "--detach",
            "--publish",
            `127.0.0.1:${port}:5432`,
            "--env",
            "POSTGRES_PASSWORD=postgres",
            "--env",
            "POSTGRES_DB=indexer",
            "--label",
            "coordination-network.testbed=postgres",
            POSTGRES_IMAGE
        ],
        { encoding: "utf8" }
    ).trim()

    let stopped = false
    const stop = () => {
        if (stopped) return
        stopped = true
        try {
            execFileSync("docker", ["kill", containerId], { stdio: "ignore" })
        } catch {
            // The --rm container may already have stopped itself.
        }
    }

    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            // The official image briefly starts a Unix-socket-only server while
            // initializing an empty database. TCP readiness proves that the
            // final server used by the indexer is accepting connections.
            execFileSync(
                "docker",
                ["exec", containerId, "pg_isready", "-h", "127.0.0.1", "-U", "postgres", "-d", "indexer"],
                { stdio: "ignore" }
            )
            return {
                containerId,
                databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/indexer`,
                stop
            }
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 200))
        }
    }

    stop()
    throw new Error("PostgreSQL container did not become ready")
}

async function closeServer(server: HttpServer): Promise<void> {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
    for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
    }
}

export async function startTestbedIndexer(
    chain: Chain,
    deployment: StealthDeployment,
    startBlock: bigint,
    diagnostic: (message: string) => void = () => {}
): Promise<TestbedIndexer> {
    const postgres = await startPostgres()
    const port = await freePort()
    const environment = {
        PORT: String(port),
        TRUSTED_PROXY_ADDRESS: "127.0.0.1",
        RPC_URL: chain.rpcUrl,
        ANNOUNCER_ADDRESS: deployment.announcer.address,
        TOKEN_ADDRESS: deployment.token.address,
        START_BLOCK: String(startBlock),
        SCAN_INTERVAL_MS: "50",
        MAX_BLOCK_SCAN_WINDOW_SIZE: String(chain.blockScanWindowSize),
        CONFIRMATIONS: "0",
        AUTH_TOKEN,
        ENCRYPTION_KEY,
        LOOKUP_HASH_KEY,
        DATABASE_URL: postgres.databaseUrl,
        LOG_LEVEL: "info",
        LOG_FORMAT: "json"
    }
    const previousEnvironment = Object.fromEntries(
        Object.keys(environment).map((name) => [name, process.env[name]])
    ) as Record<string, string | undefined>
    Object.assign(process.env, environment)

    const { listener: runningListener, stopIndexer: stopRunningIndexer } = await (async () => {
        let listener: HttpServer | undefined
        let stopIndexer: (() => Promise<void>) | undefined

        try {
            // Config is validated at import time, after the harness allocates the
            // chain, contracts, HTTP port and disposable database.
            const { startIndexer } = await import("../../indexer/src/server.ts")
            const indexer = await startIndexer()
            stopIndexer = indexer.stop
            listener = indexer.app.listen(port, "127.0.0.1")
            await once(listener, "listening")
            return { listener, stopIndexer }
        } catch (error) {
            if (listener) await closeServer(listener)
            if (stopIndexer) await stopIndexer()
            postgres.stop()
            restoreEnvironment(previousEnvironment)
            throw error
        }
    })()

    const url = `http://127.0.0.1:${port}`
    const authorization = { authorization: `Bearer ${AUTH_TOKEN}` }
    let stopped = false

    async function request(path: string, init?: RequestInit): Promise<Response> {
        const response = await fetch(`${url}${path}`, {
            ...init,
            headers: { ...authorization, ...(init?.headers as Record<string, string> | undefined) }
        })
        if (!response.ok) throw new Error(`indexer ${init?.method ?? "GET"} ${path} returned ${response.status}`)
        return response
    }

    async function health(): Promise<IndexerHealth> {
        return (await (await request("/health")).json()) as IndexerHealth
    }

    diagnostic(
        `Indexer ${url}; PostgreSQL container ${postgres.containerId.slice(0, 12)} (${POSTGRES_IMAGE}) at ${new URL(postgres.databaseUrl).host}`
    )

    return {
        url,
        async registerKey(input): Promise<void> {
            const response = await request("/keys", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(input, (_key, value) => (typeof value === "bigint" ? value.toString() : value))
            })
            if (response.status !== 201) throw new Error("indexer key was already registered")
        },
        async accounts(networkId): Promise<IndexedAccount[]> {
            const response = await request(`/accounts?networkId=${networkId}`)
            const body = (await response.json()) as { accounts: IndexedAccount[]; nextCursor: string | null }
            if (body.nextCursor !== null) throw new Error("integration test account query unexpectedly paginated")
            return body.accounts
        },
        async balances(networkId, tokenIds): Promise<IndexedBalance[]> {
            const parameters = new URLSearchParams({ networkId })
            for (const tokenId of tokenIds) parameters.append("tokenIds", tokenId.toString())
            const response = await request(`/balances?${parameters}`)
            const body = (await response.json()) as { balances: IndexedBalance[]; nextCursor: string | null }
            if (body.nextCursor !== null) throw new Error("integration test balance query unexpectedly paginated")
            return body.balances
        },
        async waitUntilScanned(blockNumber): Promise<IndexerHealth> {
            const deadline = Date.now() + 15_000
            let current: IndexerHealth | undefined
            while (Date.now() < deadline) {
                current = await health()
                if (
                    current.lastError === null &&
                    current.lastScanAt !== null &&
                    BigInt(current.latestBlock) >= blockNumber &&
                    BigInt(current.lowestScannedBlock) >= blockNumber &&
                    current.lagBlocks === "0"
                ) {
                    return current
                }
                await new Promise((resolve) => setTimeout(resolve, 50))
            }
            throw new Error(`indexer did not scan block ${blockNumber}; health=${JSON.stringify(current)}`)
        },
        async stop(): Promise<void> {
            if (stopped) return
            stopped = true
            await closeServer(runningListener)
            await stopRunningIndexer()
            postgres.stop()
            restoreEnvironment(previousEnvironment)
        }
    }
}
