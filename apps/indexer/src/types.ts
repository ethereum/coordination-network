import type { Address, Hex } from "viem"

/** One Announcement event from the announcer contract, decoded. */
export type Announcement = {
    schemeId: bigint
    stealthAddress: Address
    caller: Address
    ephemeralPublicKey: Hex
    // the first byte is the view tag
    metadata: Hex
    blockNumber: bigint
    txHash: Hex
    logIndex: number
}

/** The key pair needed to scan for one stealth address, and the entity it belongs to. */
export type AnnouncementKeys = {
    networkId: Hex
    spendingPublicKey: Hex
    viewingPrivateKey: Hex
}

/** A key in the database, with its scan bookmark. */
export type RegisteredKey = AnnouncementKeys & {
    // every block up to and including this one has been checked for this key
    scannedUntilBlock: bigint
}

/** An announcement that belongs to one of the users, and the key it matched. */
export type MatchedAnnouncement = {
    announcement: Announcement
    networkId: Hex
    spendingPublicKey: Hex
}

/** Scan progress, served on /health. */
export type AnnouncementScanStatus = {
    // the chain's latest block
    latestBlock: bigint
    // current getLogs block scan window size in blocks
    blockScanWindowSize: number
    // true while a scan is running, so scans never overlap
    scanning: boolean
    lastScanAt: string | null
    lastError: string | null
}
