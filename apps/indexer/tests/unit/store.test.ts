import type pg from "pg"
import { logger } from "../../src/logger.ts"
import { listAccounts, listKeys, registerKeys } from "../../src/store.ts"
import { announcement, key1, keyCipher } from "../utils/fixtures.ts"

type QueryResult = { rows: Array<Record<string, unknown>>; rowCount: number }

/** A pool that answers every query the same way and records what it was asked. */
function fakePool(result: Partial<QueryResult> = {}) {
    const queries: Array<{ text: string; values: Array<unknown> }> = []
    const query = async (text: string, values: Array<unknown> = []) => {
        queries.push({ text, values })
        return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 }
    }
    const pool = { query, connect: async () => ({ query, release: () => {} }) }
    return { queries, pool: pool as unknown as pg.Pool }
}

test("listKeys returns an empty array when the database holds no keys", async () => {
    const { pool } = fakePool()

    expect(await listKeys(pool, keyCipher)).toEqual([])
})

test("listAccounts returns nothing for an entity with no accounts", async () => {
    const { pool } = fakePool()

    expect(await listAccounts(pool, keyCipher, { networkId: key1.networkId, limit: 10, after: 0n })).toEqual([])
})

test("registerKeys writes no value of the key unencrypted", async () => {
    const { queries, pool } = fakePool({ rowCount: 1 })

    await registerKeys(pool, keyCipher, [{ ...key1, scannedUntilBlock: 0n }])

    const storedValues = queries[0].values.join(" ")
    expect(storedValues).not.toContain(key1.spendingPublicKey.slice(2))
    expect(storedValues).not.toContain(key1.networkId.slice(2))
    expect(storedValues).not.toContain(key1.viewingPrivateKey.slice(2))
})

test("listKeys skips a key whose stored values cannot be decrypted", async () => {
    const errorLog = jest.spyOn(logger, "error").mockImplementation(() => {})
    const { pool } = fakePool({
        rows: [
            {
                spending_public_key_hash: keyCipher.lookupHash(key1.spendingPublicKey),
                encrypted_spending_public_key: keyCipher.encrypt(key1.spendingPublicKey),
                encrypted_network_id: keyCipher.encrypt(key1.networkId),
                encrypted_viewing_private_key: "0xnotcipherText",
                scanned_until_block: 0n
            }
        ]
    })

    const keys = await listKeys(pool, keyCipher)

    // one unreadable row must not stop the scan for everyone else
    expect(keys).toHaveLength(0)
    expect(errorLog).toHaveBeenCalledTimes(1)
    errorLog.mockRestore()
})

test("listKeys returns a readable key with its bookmark", async () => {
    const { pool } = fakePool({
        rows: [
            {
                spending_public_key_hash: keyCipher.lookupHash(key1.spendingPublicKey),
                encrypted_spending_public_key: keyCipher.encrypt(key1.spendingPublicKey),
                encrypted_network_id: keyCipher.encrypt(key1.networkId),
                encrypted_viewing_private_key: keyCipher.encrypt(key1.viewingPrivateKey),
                scanned_until_block: 42n
            }
        ]
    })

    expect(await listKeys(pool, keyCipher)).toEqual([{ ...key1, scannedUntilBlock: 42n }])
})

test("listAccounts names the columns a wallet needs", async () => {
    const { pool } = fakePool({
        rows: [
            {
                id: 1n,
                encrypted_stealth_address: keyCipher.encrypt(announcement(0).stealthAddress),
                encrypted_ephemeral_public_key: keyCipher.encrypt(announcement(0).ephemeralPublicKey)
            }
        ]
    })

    expect(await listAccounts(pool, keyCipher, { networkId: key1.networkId, limit: 10, after: 0n })).toEqual([
        {
            id: 1n,
            stealthAddress: announcement(0).stealthAddress,
            ephemeralPublicKey: announcement(0).ephemeralPublicKey
        }
    ])
})
