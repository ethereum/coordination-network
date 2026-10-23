import { parseAbiItem } from "viem"
import { config } from "./config.ts"
import { Announcement } from "./types.ts"

const announcementEvent = parseAbiItem(
    "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)"
)

/** Fetches the announcer's Announcement events for a block range. */
export async function fetchAnnouncements({
    fromBlock,
    toBlock
}: {
    fromBlock: bigint
    toBlock: bigint
}): Promise<Announcement[]> {
    const logs = await config.client.getLogs({
        address: config.announcer,
        event: announcementEvent,
        fromBlock,
        toBlock,
        strict: true
    })

    return logs.map((log) => ({
        schemeId: log.args.schemeId,
        stealthAddress: log.args.stealthAddress,
        caller: log.args.caller,
        ephemeralPublicKey: log.args.ephemeralPubKey,
        metadata: log.args.metadata,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.logIndex
    }))
}
