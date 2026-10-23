import { execFileSync } from "node:child_process"
import type pg from "pg"
import { config } from "../../src/config.ts"
import { createPool } from "../../src/db.ts"

// jest runs these files in parallel, so each needs its own container.
export const INTEGRATION_TEST_PORT = Number(new URL(config.databaseUrl).port)
export const DB_TEST_PORT = INTEGRATION_TEST_PORT + 1
export const STORE_TEST_PORT = INTEGRATION_TEST_PORT + 2

export type TestDatabase = {
    databaseUrl: string
    pool: pg.Pool
    stop: () => void
}

/** Runs a throwaway postgres container and waits until it accepts queries. */
export async function startPostgres(port: number): Promise<TestDatabase> {
    const name = `indexer-test-postgres-${port}`

    // a run killed before its afterAll leaves container running
    execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" })

    execFileSync("docker", [
        "run",
        "--rm",
        "--detach",
        "--name",
        name,
        "--publish",
        `127.0.0.1:${port}:5432`,
        "--env",
        "POSTGRES_PASSWORD=postgres",
        "--env",
        "POSTGRES_DB=indexer",
        "postgres:18-alpine"
    ])

    const stop = () => {
        execFileSync("docker", ["kill", name], { stdio: "ignore" })
    }

    const databaseUrl = `postgres://postgres:postgres@127.0.0.1:${port}/indexer`
    const pool = createPool(databaseUrl)

    for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
            await pool.query("SELECT 1")
            return { databaseUrl, pool, stop }
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 200))
        }
    }
    await pool.end()
    stop()
    throw new Error("postgres container did not become ready")
}
