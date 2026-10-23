import express from "express"
import {
    blockScanWindowEnd,
    growBlockScanWindow,
    isBlockScanWindowTooLargeError,
    shrinkBlockScanWindow
} from "./blockScanWindow.ts"
import { config } from "./config.ts"
import { applySchema, createPool } from "./db.ts"
import { fetchAnnouncements } from "./fetchAnnouncements.ts"
import { createKeyCipher } from "./keyCipher.ts"
import { logger } from "./logger.ts"
import { createRoutes } from "./routes.ts"
import { scanAnnouncements } from "./scanAnnouncements.ts"
import { createStore, type Store } from "./store.ts"
import { AnnouncementScanStatus, RegisteredKey } from "./types.ts"

/** The block every key has been scanned up to. */
function lowestScannedUntilBlock(keys: Array<RegisteredKey>): bigint {
    let lowestBlock = keys[0].scannedUntilBlock
    for (const key of keys) {
        if (key.scannedUntilBlock < lowestBlock) lowestBlock = key.scannedUntilBlock
    }
    return lowestBlock
}

/** Scans one block scan window: fetch its announcements, match them against the lagging keys, save. */
async function scanAnnouncementsInBlockScanWindow(
    store: Store,
    keys: Array<RegisteredKey>,
    fromBlock: bigint,
    toBlock: bigint
) {
    const announcements = await fetchAnnouncements({ fromBlock, toBlock })
    const announcementKeysToScan = keys.filter((key) => key.scannedUntilBlock < toBlock)
    const matchedAnnouncements = scanAnnouncements({ announcements, announcementKeys: announcementKeysToScan })
    await store.saveScanResult({
        matchedAnnouncements,
        scannedSpendingPublicKeys: announcementKeysToScan.map((key) => key.spendingPublicKey),
        toBlock
    })
}

/** Walks the chain in block scan windows, from the key that is furthest behind up to the latest safe block. */
async function catchUpToLatestBlock(
    store: Store,
    announcementScanStatus: AnnouncementScanStatus,
    stopRequested: () => boolean
) {
    // cacheTime 0: the client otherwise serves a block number cached for seconds
    const latestBlock = await config.client.getBlockNumber({ cacheTime: 0 })
    announcementScanStatus.latestBlock = latestBlock

    const keys = await store.listKeys()
    if (keys.length === 0) return

    // stop short of the latest block. Bookmarks never rewind, so a block is
    // only scanned once a shallow reorg can no longer replace it
    const scanUntilBlock = latestBlock - BigInt(config.confirmations)
    let fromBlock = lowestScannedUntilBlock(keys) + 1n

    // catching up from far behind can take many windows. On shutdown, finish the current
    // scan and leave the rest for the next start, which resumes from the saved bookmark
    while (fromBlock <= scanUntilBlock && !stopRequested()) {
        const toBlock = blockScanWindowEnd(fromBlock, scanUntilBlock, announcementScanStatus.blockScanWindowSize)
        try {
            await scanAnnouncementsInBlockScanWindow(store, keys, fromBlock, toBlock)
        } catch (error) {
            // only a too-large window is fixed by shrinking, anything else waits for the next scan
            if (!isBlockScanWindowTooLargeError(error) || announcementScanStatus.blockScanWindowSize === 1) {
                throw error
            }
            announcementScanStatus.blockScanWindowSize = shrinkBlockScanWindow(
                announcementScanStatus.blockScanWindowSize
            )
            continue
        }
        announcementScanStatus.blockScanWindowSize = growBlockScanWindow(
            announcementScanStatus.blockScanWindowSize,
            config.maxBlockScanWindowSize
        )
        fromBlock = toBlock + 1n
    }
}

/** One scan. Skips if the previous scan is still running, never throws. */
async function runAnnouncementScan(
    store: Store,
    announcementScanStatus: AnnouncementScanStatus,
    stopRequested: () => boolean
) {
    if (announcementScanStatus.scanning) return
    announcementScanStatus.scanning = true
    try {
        await catchUpToLatestBlock(store, announcementScanStatus, stopRequested)
        announcementScanStatus.lastScanAt = new Date().toISOString()
        announcementScanStatus.lastError = null
    } catch (error) {
        announcementScanStatus.lastError = String(error)
        logger.error({ lastError: announcementScanStatus.lastError }, "scan failed, retrying next interval")
    } finally {
        announcementScanStatus.scanning = false
    }
}

/** Boots the indexer: database, scan loop, HTTP app. */
export async function startIndexer() {
    const pool = createPool(config.databaseUrl)
    await applySchema(pool)
    const keyCipher = createKeyCipher({ encryptionKey: config.encryptionKey, lookupHashKey: config.lookupHashKey })
    const store = createStore(pool, keyCipher)

    // shared object mutatated in place.
    const announcementScanStatus: AnnouncementScanStatus = {
        latestBlock: 0n,
        blockScanWindowSize: config.maxBlockScanWindowSize,
        scanning: false,
        lastScanAt: null,
        lastError: null
    }

    let stopping = false
    const stopRequested = () => stopping

    let currentScan = runAnnouncementScan(store, announcementScanStatus, stopRequested)
    const interval = setInterval(() => {
        // calling it again while a scan is running scans nothing and finishes at once,
        // and stop() would wait on that instead of on the scan that is running
        if (announcementScanStatus.scanning) return
        currentScan = runAnnouncementScan(store, announcementScanStatus, stopRequested)
    }, config.scanIntervalMs)

    const app = express()
    // the host decrypts https on a proxy machine before forwarding to this one, so the connection we see comes
    // from that machine. Express takes the caller's address from the header that the proxy adds only
    // when the connection comes from a trusted proxy address.
    app.set("trust proxy", config.trustedProxyAddress)
    app.use(createRoutes(store, announcementScanStatus))

    return {
        app,
        stop: async () => {
            stopping = true
            clearInterval(interval)
            await currentScan
            await pool.end()
        }
    }
}
