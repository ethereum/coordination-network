import type pg from "pg"
import { Address, getAddress, Hex } from "viem"
import type { KeyCipher } from "./keyCipher.ts"
import { logger } from "./logger.ts"
import { MatchedAnnouncement, RegisteredKey } from "./types.ts"

/** Registers keys the scan should cover, returning how many were new. A key that already exists keeps its bookmark. */
export async function registerKeys(pool: pg.Pool, keyCipher: KeyCipher, keys: Array<RegisteredKey>): Promise<number> {
    let registeredCount = 0
    for (const key of keys) {
        const spendingPublicKeyHash = keyCipher.lookupHash(key.spendingPublicKey)
        const encryptedSpendingPublicKey = keyCipher.encrypt(key.spendingPublicKey)
        const networkIdHash = keyCipher.lookupHash(key.networkId)
        const encryptedNetworkId = keyCipher.encrypt(key.networkId)
        const encryptedViewingPrivateKey = keyCipher.encrypt(key.viewingPrivateKey)
        const insertion = await pool.query(
            `INSERT INTO keys
                 (spending_public_key_hash, encrypted_spending_public_key, network_id_hash,
                  encrypted_network_id, encrypted_viewing_private_key, scanned_until_block)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (spending_public_key_hash) DO NOTHING`,
            [
                spendingPublicKeyHash,
                encryptedSpendingPublicKey,
                networkIdHash,
                encryptedNetworkId,
                encryptedViewingPrivateKey,
                key.scannedUntilBlock
            ]
        )
        registeredCount += insertion.rowCount ?? 0
    }
    return registeredCount
}

/** Every registered key with its bookmark, minus any whose stored values cannot be read. */
export async function listKeys(pool: pg.Pool, keyCipher: KeyCipher): Promise<Array<RegisteredKey>> {
    const keyRows = await pool.query(
        `SELECT spending_public_key_hash, encrypted_spending_public_key, encrypted_network_id,
                encrypted_viewing_private_key, scanned_until_block
         FROM keys`
    )

    const keys: Array<RegisteredKey> = []
    for (const row of keyRows.rows) {
        try {
            const spendingPublicKey = keyCipher.decrypt(row.encrypted_spending_public_key)
            const networkId = keyCipher.decrypt(row.encrypted_network_id)
            const viewingPrivateKey = keyCipher.decrypt(row.encrypted_viewing_private_key)
            keys.push({ spendingPublicKey, networkId, viewingPrivateKey, scannedUntilBlock: row.scanned_until_block })
        } catch {
            // a row from a half-restored backup, or written under a key we no longer
            // hold, must not stop the scan for everyone else
            logger.error(
                { spendingPublicKeyHash: row.spending_public_key_hash },
                "skipping key: its stored values could not be decrypted"
            )
        }
    }
    return keys
}

/** The block every key has been scanned up to, or null when no keys are registered. */
export async function lowestScannedBlock(pool: pg.Pool): Promise<bigint | null> {
    const result = await pool.query("SELECT min(scanned_until_block) AS min FROM keys")
    return result.rows[0].min
}

/**
 * Saves a scanned block scan window. Matched accounts and the moved bookmarks
 * commit together or not at all, so a bookmark can never get ahead of its
 * data. Only the scanned keys move, since a key registered mid-scan was
 * never checked against this window.
 */
export async function saveScanResult(
    pool: pg.Pool,
    keyCipher: KeyCipher,
    {
        matchedAnnouncements,
        scannedSpendingPublicKeys,
        toBlock
    }: { matchedAnnouncements: Array<MatchedAnnouncement>; scannedSpendingPublicKeys: Array<Hex>; toBlock: bigint }
) {
    const client = await pool.connect()
    try {
        await client.query("BEGIN")
        for (const { announcement, networkId, spendingPublicKey } of matchedAnnouncements) {
            const networkIdHash = keyCipher.lookupHash(networkId)
            const stealthAddressHash = keyCipher.lookupHash(announcement.stealthAddress)
            const encryptedStealthAddress = keyCipher.encrypt(announcement.stealthAddress)
            const encryptedEphemeralPublicKey = keyCipher.encrypt(announcement.ephemeralPublicKey)
            const spendingPublicKeyHash = keyCipher.lookupHash(spendingPublicKey)
            await client.query(
                `INSERT INTO accounts
                     (network_id_hash, stealth_address_hash, encrypted_stealth_address,
                      encrypted_ephemeral_public_key, spending_public_key_hash)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT DO NOTHING`,
                [
                    networkIdHash,
                    stealthAddressHash,
                    encryptedStealthAddress,
                    encryptedEphemeralPublicKey,
                    spendingPublicKeyHash
                ]
            )
        }
        // moves the bookmark forward for every key scanned this window, never backward
        await client.query(
            `UPDATE keys SET scanned_until_block = $1
             WHERE spending_public_key_hash = ANY($2) AND scanned_until_block < $1`,
            [toBlock, scannedSpendingPublicKeys.map(keyCipher.lookupHash)]
        )
        await client.query("COMMIT")
    } catch (error) {
        await client.query("ROLLBACK")
        throw error
    } finally {
        client.release()
    }
}

/** One page of an entity's discovered stealth accounts in discovery order, starting after the cursor. */
export async function listAccounts(
    pool: pg.Pool,
    keyCipher: KeyCipher,
    { networkId, limit, after }: { networkId: Hex; limit: number; after: bigint }
): Promise<Array<{ id: bigint; stealthAddress: Address; ephemeralPublicKey: Hex }>> {
    const networkIdHash = keyCipher.lookupHash(networkId)
    const accountRows = await pool.query(
        `SELECT id, encrypted_stealth_address, encrypted_ephemeral_public_key
         FROM accounts
         WHERE network_id_hash = $1 AND id > $2
         ORDER BY id
         LIMIT $3`,
        [networkIdHash, after, limit]
    )
    return accountRows.rows.map((row) => {
        const stealthAddress = keyCipher.decrypt(row.encrypted_stealth_address)
        const ephemeralPublicKey = keyCipher.decrypt(row.encrypted_ephemeral_public_key)
        const checksummedStealthAddress = getAddress(stealthAddress)
        return { id: row.id, stealthAddress: checksummedStealthAddress, ephemeralPublicKey }
    })
}

/** Deletes an entity's keys and the accounts found with them. Returns how many keys were deleted. */
export async function deleteKeys(pool: pg.Pool, keyCipher: KeyCipher, networkId: Hex): Promise<number> {
    const networkIdHash = keyCipher.lookupHash(networkId)
    const deletion = await pool.query("DELETE FROM keys WHERE network_id_hash = $1", [networkIdHash])
    return deletion.rowCount ?? 0
}

export function createStore(pool: pg.Pool, keyCipher: KeyCipher) {
    return {
        registerKeys: (keys: Array<RegisteredKey>) => registerKeys(pool, keyCipher, keys),
        listKeys: () => listKeys(pool, keyCipher),
        lowestScannedBlock: () => lowestScannedBlock(pool),
        saveScanResult: (scanResult: Parameters<typeof saveScanResult>[2]) =>
            saveScanResult(pool, keyCipher, scanResult),
        listAccounts: (query: Parameters<typeof listAccounts>[2]) => listAccounts(pool, keyCipher, query),
        deleteKeys: (networkId: Hex) => deleteKeys(pool, keyCipher, networkId)
    }
}

export type Store = ReturnType<typeof createStore>
