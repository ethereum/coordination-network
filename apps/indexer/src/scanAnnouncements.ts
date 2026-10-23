import { checkStealthAddress, ERC_5564_SCHEME_ID } from "@coordination-network/identity"
import { Announcement, AnnouncementKeys, MatchedAnnouncement } from "./types.ts"

/**
 * The key that owns the announcement, or null when none does. A one-byte
 * view-tag compare rejects most keys before the full stealth-address
 * recompute. Announcements are permissionless, so a malformed one (which
 * throws inside checkStealthAddress for every key) counts as unowned.
 */
function matchAnnouncementToKey(
    announcement: Announcement,
    announcementKeys: Array<AnnouncementKeys>
): MatchedAnnouncement | null {
    const viewTag = Number.parseInt(announcement.metadata.slice(2, 4), 16)

    for (const announcementKey of announcementKeys) {
        try {
            const isMatchedAnnouncement = checkStealthAddress({
                stealthAddress: announcement.stealthAddress,
                ephemeralPublicKey: announcement.ephemeralPublicKey,
                spendingPublicKey: announcementKey.spendingPublicKey,
                viewingPrivateKey: announcementKey.viewingPrivateKey,
                viewTag
            })
            if (isMatchedAnnouncement) {
                return {
                    announcement,
                    networkId: announcementKey.networkId,
                    spendingPublicKey: announcementKey.spendingPublicKey
                }
            }
        } catch {
            continue
        }
    }
    return null
}

/** Checks announcements against the users' keys and returns the owned ones. */
export function scanAnnouncements({
    announcements,
    announcementKeys
}: {
    announcements: Array<Announcement>
    announcementKeys: Array<AnnouncementKeys>
}): MatchedAnnouncement[] {
    const matchedAnnouncements: MatchedAnnouncement[] = []

    for (const announcement of announcements) {
        if (announcement.schemeId !== BigInt(ERC_5564_SCHEME_ID)) continue
        if (announcement.metadata.length < 4) continue

        const matchedAnnouncement = matchAnnouncementToKey(announcement, announcementKeys)
        if (matchedAnnouncement) matchedAnnouncements.push(matchedAnnouncement)
    }

    return matchedAnnouncements
}
