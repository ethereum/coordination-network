import { readFileSync } from "node:fs"
import { join } from "node:path"
import pg from "pg"
import { logger } from "./logger.ts"

// postgres sends BIGINT columns as strings. Block numbers must come back as bigints
pg.types.setTypeParser(pg.types.builtins.INT8, BigInt)

/** Creates the connection pool every query in the app goes through. */
export function createPool(databaseUrl: string): pg.Pool {
    const pool = new pg.Pool({ connectionString: databaseUrl })
    // an idle client losing its connection emits an error event on the pool.
    // Left unhandled, that event kills the process
    pool.on("error", (error) => {
        logger.error({ err: error }, "postgres pool error")
    })
    return pool
}

/** Creates the tables on a fresh database. A no-op when they already exist. */
export async function applySchema(pool: pg.Pool) {
    const schema = readFileSync(join(__dirname, "../schema.sql"), "utf8")
    await pool.query(schema)
}
