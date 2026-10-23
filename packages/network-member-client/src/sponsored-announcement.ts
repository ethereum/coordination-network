import { encodeFunctionData } from "viem"
import type { Address, Hex } from "viem"
import { ERC5564_ANNOUNCER_ABI } from "./adapters"
import { SponsoredRelay } from "./sponsored-relay"
import type { Announcement, AnnouncementSubmitter } from "./types"

/**
 * Sponsored AnnouncementSubmitter: relays `ERC5564Announcer.announce` through {@link SponsoredRelay},
 * so the indexed `caller` of the `Announcement` is a one-time sender, not the member. A direct
 * `ERC5564AnnouncerClient` would put one fixed address on every delivery the member makes.
 */
export class SponsoredAnnouncementSubmitter implements AnnouncementSubmitter {
    constructor(
        readonly announcerAddress: Address,
        private readonly relay: SponsoredRelay
    ) {}

    async announce(announcement: Announcement): Promise<Hex> {
        const { receipt } = await this.relay.relay({
            target: this.announcerAddress,
            data: encodeFunctionData({
                abi: ERC5564_ANNOUNCER_ABI,
                functionName: "announce",
                args: [
                    BigInt(announcement.schemeId),
                    announcement.stealthAddress,
                    announcement.ephemeralPublicKey,
                    announcement.metadata
                ]
            })
        })

        // The announcer has no named errors, so the raw revert data is all there is to report. Assigned,
        // not passed as an option, because the repo's ES2020 target has no ErrorOptions.
        if (!receipt.success)
            throw Object.assign(new Error("sponsored announce reverted"), { cause: receipt.revertReason })

        return receipt.transactionHash
    }
}
