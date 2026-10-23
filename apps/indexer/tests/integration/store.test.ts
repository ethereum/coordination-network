import { applySchema } from "../../src/db.ts"
import {
    listAccounts,
    listKeys,
    lowestScannedBlock,
    registerKeys,
    saveScanResult,
    deleteKeys
} from "../../src/store.ts"
import { announcement, key1, key2, keyCipher } from "../utils/fixtures.ts"
import { STORE_TEST_PORT, startPostgres, type TestDatabase } from "../utils/db.ts"
import { MatchedAnnouncement } from "../../src/types.ts"

let db: TestDatabase

beforeAll(async () => {
    db = await startPostgres(STORE_TEST_PORT)
})

afterAll(async () => {
    await db.pool.end()
    db.stop()
})

beforeEach(async () => {
    await db.pool.query("DROP TABLE IF EXISTS accounts, keys")
    await applySchema(db.pool)
})

test("registerKeys stores a new key with its given bookmark", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 5n }])

    const keys = await listKeys(db.pool, keyCipher)
    expect(keys).toEqual([{ ...key1, scannedUntilBlock: 5n }])
})

test("registerKeys counts only the keys it actually inserted", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 5n }])

    const registeredCount = await registerKeys(db.pool, keyCipher, [
        { ...key1, scannedUntilBlock: 5n },
        { ...key2, scannedUntilBlock: 5n }
    ])

    expect(registeredCount).toBe(1)
})

test("registerKeys keeps the existing bookmark for a known key", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 5n }])
    await registerKeys(db.pool, keyCipher, [
        { ...key1, scannedUntilBlock: 100n },
        { ...key2, scannedUntilBlock: 100n }
    ])

    const keys = await listKeys(db.pool, keyCipher)
    const bookmarks = new Map(keys.map((key) => [key.spendingPublicKey, key.scannedUntilBlock]))
    expect(bookmarks.get(key1.spendingPublicKey)).toBe(5n)
    expect(bookmarks.get(key2.spendingPublicKey)).toBe(100n)
})

test("registerKeys inserts a key once when two callers register it at the same time", async () => {
    const registeredCounts = await Promise.all([
        registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 5n }]),
        registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 5n }])
    ])

    expect(registeredCounts.sort()).toEqual([0, 1])
    expect(await listKeys(db.pool, keyCipher)).toHaveLength(1)
})

test("lowestScannedBlock is null with no keys", async () => {
    expect(await lowestScannedBlock(db.pool)).toBeNull()
})

test("lowestScannedBlock returns the smallest bookmark across all keys", async () => {
    await registerKeys(db.pool, keyCipher, [
        { ...key1, scannedUntilBlock: 5n },
        { ...key2, scannedUntilBlock: 50n }
    ])

    expect(await lowestScannedBlock(db.pool)).toBe(5n)
})

test("saveScanResult moves only bookmarks behind the window end", async () => {
    await registerKeys(db.pool, keyCipher, [
        { ...key1, scannedUntilBlock: 5n },
        { ...key2, scannedUntilBlock: 50n }
    ])

    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements: [],
        scannedSpendingPublicKeys: [key1.spendingPublicKey, key2.spendingPublicKey],
        toBlock: 20n
    })

    const keys = await listKeys(db.pool, keyCipher)
    const bookmarks = new Map(keys.map((key) => [key.spendingPublicKey, key.scannedUntilBlock]))
    // bookmark moved forward
    expect(bookmarks.get(key1.spendingPublicKey)).toBe(20n)
    // a key ahead of the window must not rewind
    expect(bookmarks.get(key2.spendingPublicKey)).toBe(50n)
})

test("saveScanResult does not advance a key that was not scanned", async () => {
    await registerKeys(db.pool, keyCipher, [
        { ...key1, scannedUntilBlock: 5n },
        // registered mid-scan, after the scan's key snapshot
        { ...key2, scannedUntilBlock: 0n }
    ])

    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements: [],
        scannedSpendingPublicKeys: [key1.spendingPublicKey],
        toBlock: 20n
    })

    const keys = await listKeys(db.pool, keyCipher)
    const bookmarks = new Map(keys.map((key) => [key.spendingPublicKey, key.scannedUntilBlock]))
    expect(bookmarks.get(key1.spendingPublicKey)).toBe(20n)
    // an unscanned key's bookmark must not move
    expect(bookmarks.get(key2.spendingPublicKey)).toBe(0n)
})

test("saveScanResult stores a matched announcement as an account", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 0n }])
    const matchedAnnouncements: MatchedAnnouncement[] = [
        { announcement: announcement(0), networkId: key1.networkId, spendingPublicKey: key1.spendingPublicKey }
    ]

    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements,
        scannedSpendingPublicKeys: [key1.spendingPublicKey],
        toBlock: 10n
    })

    const stealthAddresses = (
        await listAccounts(db.pool, keyCipher, { networkId: key1.networkId, limit: 100, after: 0n })
    ).map((account) => account.stealthAddress)

    expect(stealthAddresses).toEqual([announcement(0).stealthAddress])
})

test("saving the same window twice creates no duplicate accounts", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 0n }])
    const matchedAnnouncements: MatchedAnnouncement[] = [
        { announcement: announcement(0), networkId: key1.networkId, spendingPublicKey: key1.spendingPublicKey }
    ]

    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements,
        scannedSpendingPublicKeys: [key1.spendingPublicKey],
        toBlock: 10n
    })
    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements,
        scannedSpendingPublicKeys: [key1.spendingPublicKey],
        toBlock: 10n
    })

    const stealthAddresses = (
        await listAccounts(db.pool, keyCipher, { networkId: key1.networkId, limit: 100, after: 0n })
    ).map((account) => account.stealthAddress)

    expect(stealthAddresses).toEqual([announcement(0).stealthAddress])
})

test("a failed save commits no accounts", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 0n }])
    const unknownKeyMatch: MatchedAnnouncement[] = [
        { announcement: announcement(0), networkId: key1.networkId, spendingPublicKey: `0x02${"99".repeat(32)}` }
    ]

    // violates the accounts -> keys foreign key, so the whole transaction rolls back
    await expect(
        saveScanResult(db.pool, keyCipher, {
            matchedAnnouncements: unknownKeyMatch,
            scannedSpendingPublicKeys: [key1.spendingPublicKey],
            toBlock: 10n
        })
    ).rejects.toThrow()

    const stealthAddresses = (
        await listAccounts(db.pool, keyCipher, { networkId: key1.networkId, limit: 100, after: 0n })
    ).map((account) => account.stealthAddress)

    expect(stealthAddresses).toEqual([])
})

test("a failed save does not move bookmarks either", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 0n }])
    const unknownKeyMatch: MatchedAnnouncement[] = [
        { announcement: announcement(0), networkId: key1.networkId, spendingPublicKey: `0x02${"99".repeat(32)}` }
    ]

    await expect(
        saveScanResult(db.pool, keyCipher, {
            matchedAnnouncements: unknownKeyMatch,
            scannedSpendingPublicKeys: [key1.spendingPublicKey],
            toBlock: 10n
        })
    ).rejects.toThrow()

    // bookmark must not move when the data failed to save
    expect(await lowestScannedBlock(db.pool)).toBe(0n)
})

test("listAccounts leaves out the accounts of other entities", async () => {
    await registerKeys(db.pool, keyCipher, [
        { ...key1, scannedUntilBlock: 0n },
        { ...key2, scannedUntilBlock: 0n }
    ])
    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements: [
            { announcement: announcement(0), networkId: key1.networkId, spendingPublicKey: key1.spendingPublicKey },
            { announcement: announcement(1), networkId: key2.networkId, spendingPublicKey: key2.spendingPublicKey }
        ],
        scannedSpendingPublicKeys: [key1.spendingPublicKey, key2.spendingPublicKey],
        toBlock: 10n
    })

    const stealthAddresses = (
        await listAccounts(db.pool, keyCipher, { networkId: key2.networkId, limit: 100, after: 0n })
    ).map((account) => account.stealthAddress)

    expect(stealthAddresses).toEqual([announcement(1).stealthAddress])
})

test("listAccounts pages through accounts with a cursor", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 0n }])
    const matchedAnnouncements: MatchedAnnouncement[] = [0, 1, 2].map((logIndex) => ({
        announcement: announcement(logIndex),
        networkId: key1.networkId,
        spendingPublicKey: key1.spendingPublicKey
    }))
    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements,
        scannedSpendingPublicKeys: [key1.spendingPublicKey],
        toBlock: 10n
    })

    const firstPage = await listAccounts(db.pool, keyCipher, { networkId: key1.networkId, limit: 2, after: 0n })
    expect(firstPage.map((account) => account.stealthAddress)).toEqual([
        announcement(0).stealthAddress,
        announcement(1).stealthAddress
    ])

    const secondPage = await listAccounts(db.pool, keyCipher, {
        networkId: key1.networkId,
        limit: 2,
        after: firstPage[1].id
    })
    // the second page starts after the first page's last account
    expect(secondPage.map((account) => account.stealthAddress)).toEqual([announcement(2).stealthAddress])
})

test("the database holds no unencrypted network ID, key or account", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 0n }])
    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements: [
            { announcement: announcement(0), networkId: key1.networkId, spendingPublicKey: key1.spendingPublicKey }
        ],
        scannedSpendingPublicKeys: [key1.spendingPublicKey],
        toBlock: 10n
    })

    const keyRows = await db.pool.query("SELECT * FROM keys")
    const accountRows = await db.pool.query("SELECT * FROM accounts")
    const storedValues = [...keyRows.rows, ...accountRows.rows].flatMap((row) => Object.values(row)).join(" ")

    expect(storedValues).not.toContain(key1.networkId.slice(2))
    expect(storedValues).not.toContain(key1.spendingPublicKey.slice(2))
    expect(storedValues).not.toContain(key1.viewingPrivateKey.slice(2))
    expect(storedValues).not.toContain(announcement(0).stealthAddress.slice(2).toLowerCase())
    expect(storedValues).not.toContain(announcement(0).ephemeralPublicKey.slice(2))
})

test("deleteKeys deletes nothing for an entity with no keys", async () => {
    await registerKeys(db.pool, keyCipher, [{ ...key1, scannedUntilBlock: 0n }])

    expect(await deleteKeys(db.pool, keyCipher, key2.networkId)).toBe(0)
    expect(await listKeys(db.pool, keyCipher)).toHaveLength(1)
})

test("deleteKeys deletes an entity's keys and accounts and leaves other entities alone", async () => {
    await registerKeys(db.pool, keyCipher, [
        { ...key1, scannedUntilBlock: 0n },
        { ...key2, scannedUntilBlock: 0n }
    ])
    await saveScanResult(db.pool, keyCipher, {
        matchedAnnouncements: [
            { announcement: announcement(0), networkId: key1.networkId, spendingPublicKey: key1.spendingPublicKey },
            { announcement: announcement(1), networkId: key2.networkId, spendingPublicKey: key2.spendingPublicKey }
        ],
        scannedSpendingPublicKeys: [key1.spendingPublicKey, key2.spendingPublicKey],
        toBlock: 10n
    })

    expect(await deleteKeys(db.pool, keyCipher, key1.networkId)).toBe(1)

    const keys = await listKeys(db.pool, keyCipher)
    const deletedAccounts = await listAccounts(db.pool, keyCipher, { networkId: key1.networkId, limit: 100, after: 0n })
    const keptAccounts = await listAccounts(db.pool, keyCipher, { networkId: key2.networkId, limit: 100, after: 0n })
    expect(keys).toEqual([{ ...key2, scannedUntilBlock: 10n }])
    expect(deletedAccounts).toEqual([])
    expect(keptAccounts.map((account) => account.stealthAddress)).toEqual([announcement(1).stealthAddress])
})
