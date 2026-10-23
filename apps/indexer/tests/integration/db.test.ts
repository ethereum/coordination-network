import { applySchema } from "../../src/db.ts"
import { DB_TEST_PORT, startPostgres, type TestDatabase } from "../utils/db.ts"

let db: TestDatabase

beforeAll(async () => {
    db = await startPostgres(DB_TEST_PORT)
})

afterAll(async () => {
    await db.pool.end()
    db.stop()
})

beforeEach(async () => {
    await db.pool.query("DROP TABLE IF EXISTS accounts, keys")
})

test("createPool returns a pool that can query the database", async () => {
    const result = await db.pool.query("SELECT 1 AS one")
    expect(result.rows[0].one).toBe(1)
})

test("applySchema creates the keys and accounts tables", async () => {
    await applySchema(db.pool)
    await expect(db.pool.query("SELECT * FROM keys")).resolves.not.toThrow()
    await expect(db.pool.query("SELECT * FROM accounts")).resolves.not.toThrow()
})

test("applySchema does not error when the tables already exist", async () => {
    await applySchema(db.pool)
    await expect(applySchema(db.pool)).resolves.not.toThrow()
})

test("applySchema does not touch existing data when the tables already exist", async () => {
    await applySchema(db.pool)
    await db.pool.query(
        `INSERT INTO keys
             (spending_public_key_hash, encrypted_spending_public_key, network_id_hash,
              encrypted_network_id, encrypted_viewing_private_key, scanned_until_block)
         VALUES ('0xkey', '0xencryptedkey', '0xnetwork', '0xencryptednetwork', '0xencryptedview', 5)`
    )

    await applySchema(db.pool)

    const result = await db.pool.query("SELECT scanned_until_block FROM keys WHERE spending_public_key_hash = '0xkey'")
    expect(result.rows[0].scanned_until_block).toBe(5n)
})
