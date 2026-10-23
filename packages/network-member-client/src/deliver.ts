import { buildAnnouncement, validateMetaStealthAddress } from "@coordination-network/identity"
import type { ApprovalResolver, Hex32 } from "@coordination-network/credential"
import { NetworkMemberClientError } from "./errors"
import type { AnnouncementSubmitter, DeliveredToStealth, IdentityReader } from "./types"

export interface DeliverToStealthParams {
    memberNetworkId: Hex32
    recipientNetworkId: Hex32
}

export interface DeliverToStealthPorts {
    approval: ApprovalResolver
    identityReader: IdentityReader
    submitter: AnnouncementSubmitter
}

/**
 * Delivers value to a network member's recipient: resolves their registered identity and announces
 * a fresh stealth address for it. `ERC5564Announcer.announce` is permissionless, so the member's
 * approval is checked here, first, before any other port runs.
 */
export async function deliverToStealth(
    { memberNetworkId, recipientNetworkId }: DeliverToStealthParams,
    { approval, identityReader, submitter }: DeliverToStealthPorts
): Promise<DeliveredToStealth> {
    if (!(await approval.isApprovedNetworkMember(memberNetworkId))) {
        throw new NetworkMemberClientError("MEMBER_NOT_APPROVED", "network member is not approved")
    }

    const metaStealthAddress = await identityReader.getIdentity(recipientNetworkId)
    if (metaStealthAddress === null) {
        throw new NetworkMemberClientError("RECIPIENT_NOT_REGISTERED", "recipient has no registered identity")
    }
    if (!validateMetaStealthAddress(metaStealthAddress)) {
        throw new NetworkMemberClientError(
            "INVALID_META_STEALTH_ADDRESS",
            "recipient's registered meta-stealth address is malformed"
        )
    }

    const announcement = buildAnnouncement({ metaStealthAddress })
    const txHash = await submitter.announce(announcement)

    return { stealthAddress: announcement.stealthAddress, announcement, txHash }
}
