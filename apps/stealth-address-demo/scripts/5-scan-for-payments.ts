import { parseAbiItem, type Address, type Hex } from "viem"
import { checkStealthAddress, deriveKeys, ERC_5564_SCHEME_ID } from "@coordination-network/identity"
import { publicClient } from "./config.ts"

const announcementEvent = parseAbiItem(
    "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)"
)

/**
 * Step 5, receiver. The one-byte view tag discards most irrelevant announcements.
 */
export async function scanForAnnouncement(deviceSecret: Hex, announcerAddress: Address): Promise<Address | null> {
    const keys = deriveKeys(deviceSecret)

    const announcementLogs = await publicClient.getLogs({
        address: announcerAddress,
        event: announcementEvent,
        fromBlock: 0n,
        toBlock: await publicClient.getBlockNumber({ cacheTime: 0 }),
        strict: true
    })

    // only search for the first one, but there may be multiple in practice.
    const ownedAnnouncement = announcementLogs.find(({ args: announcement }) => {
        if (announcement.schemeId !== BigInt(ERC_5564_SCHEME_ID)) return false

        return checkStealthAddress({
            stealthAddress: announcement.stealthAddress,
            ephemeralPublicKey: announcement.ephemeralPubKey,
            spendingPublicKey: keys.spending.publicKey,
            viewingPrivateKey: keys.viewing.privateKey,
            viewTag: Number.parseInt(announcement.metadata.slice(2, 4), 16)
        })
    })
    if (!ownedAnnouncement) {
        return null
    }

    return ownedAnnouncement.args.stealthAddress.toLowerCase() as Address
}
