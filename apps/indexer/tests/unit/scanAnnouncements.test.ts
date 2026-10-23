import { deriveKeys } from "@coordination-network/identity"
import { scanAnnouncements } from "../../src/scanAnnouncements.ts"
import { buildAnnouncementFor } from "../utils/chain.ts"
import { announcement, key1 } from "../utils/fixtures.ts"
import { Announcement, AnnouncementKeys } from "../../src/types.ts"

const userKeys = deriveKeys(`0x${"07".repeat(32)}`)
const strangerKeys = deriveKeys(`0x${"08".repeat(32)}`)

const userAnnouncementKeys: AnnouncementKeys = {
    networkId: `0x${"a1".repeat(32)}`,
    spendingPublicKey: userKeys.spending.publicKey,
    viewingPrivateKey: userKeys.viewing.privateKey
}
const strangerAnnouncementKeys: AnnouncementKeys = {
    networkId: `0x${"a2".repeat(32)}`,
    spendingPublicKey: strangerKeys.spending.publicKey,
    viewingPrivateKey: strangerKeys.viewing.privateKey
}

// a viewing private key outside that throws in the checkStealthAddress shared-secret step
const malformedKey: AnnouncementKeys = { ...key1, viewingPrivateKey: `0x${"00".repeat(32)}` }

/** The fixture announcement with real stealth address, as the scan sees it after fetching logs. */
function announcementFor(keys: ReturnType<typeof deriveKeys>, logIndex = 0): Announcement {
    const { schemeId, stealthAddress, ephemeralPublicKey, metadata } = buildAnnouncementFor({
        spendingPublicKey: keys.spending.publicKey,
        viewingPublicKey: keys.viewing.publicKey
    })
    return { ...announcement(logIndex), schemeId: BigInt(schemeId), stealthAddress, ephemeralPublicKey, metadata }
}

test("scanAnnouncements returns nothing when there are no keys to scan for", () => {
    const matches = scanAnnouncements({ announcements: [announcementFor(userKeys)], announcementKeys: [] })

    expect(matches).toEqual([])
})

test("scanAnnouncements skips an announcement from another scheme", () => {
    const announcement = { ...announcementFor(userKeys), schemeId: 2n }

    const matches = scanAnnouncements({ announcements: [announcement], announcementKeys: [userAnnouncementKeys] })

    expect(matches).toEqual([])
})

test("scanAnnouncements skips an announcement with no view tag", () => {
    const announcement: Announcement = { ...announcementFor(userKeys), metadata: "0x" }

    const matches = scanAnnouncements({ announcements: [announcement], announcementKeys: [userAnnouncementKeys] })

    expect(matches).toEqual([])
})

test("scanAnnouncements ignores an announcement belonging to another entity", () => {
    const matches = scanAnnouncements({
        announcements: [announcementFor(strangerKeys)],
        announcementKeys: [userAnnouncementKeys]
    })

    expect(matches).toEqual([])
})

test("scanAnnouncements treats an announcement no key can check as unowned", () => {
    const matches = scanAnnouncements({
        announcements: [announcementFor(userKeys)],
        announcementKeys: [malformedKey]
    })

    expect(matches).toEqual([])
})

test("scanAnnouncements matches a key that follows a malformed one", () => {
    const userAnnouncement = announcementFor(userKeys)

    const matches = scanAnnouncements({
        announcements: [userAnnouncement],
        announcementKeys: [malformedKey, userAnnouncementKeys]
    })

    // a key that throws must not stop the keys after it from being checked
    expect(matches).toEqual([
        {
            announcement: userAnnouncement,
            networkId: userAnnouncementKeys.networkId,
            spendingPublicKey: userKeys.spending.publicKey
        }
    ])
})

test("scanAnnouncements returns each owned announcement with the key that owns it", () => {
    const userAnnouncement = announcementFor(userKeys, 0)
    const strangerAnnouncement = announcementFor(strangerKeys, 1)
    const userSecondAnnouncement = announcementFor(userKeys, 2)

    const matches = scanAnnouncements({
        announcements: [userAnnouncement, strangerAnnouncement, userSecondAnnouncement],
        announcementKeys: [userAnnouncementKeys, strangerAnnouncementKeys]
    })

    expect(matches).toEqual([
        {
            announcement: userAnnouncement,
            networkId: userAnnouncementKeys.networkId,
            spendingPublicKey: userKeys.spending.publicKey
        },
        {
            announcement: strangerAnnouncement,
            networkId: strangerAnnouncementKeys.networkId,
            spendingPublicKey: strangerKeys.spending.publicKey
        },
        {
            announcement: userSecondAnnouncement,
            networkId: userAnnouncementKeys.networkId,
            spendingPublicKey: userKeys.spending.publicKey
        }
    ])
})
