import type { MemberContext } from "../context"
import type { MembershipOutcome } from "../outcomes"
import { failed } from "./shared"

export async function membershipStatus(ctx: MemberContext): Promise<MembershipOutcome> {
    try {
        const membership = await ctx.server.getMembership()
        return {
            status: membership.status,
            networkId: membership.networkId,
            authAddress: membership.authAddress,
            safe: membership.safe,
            identityRegistered: membership.identityRegistered,
            issuerKeyPublished: membership.issuerKeyPublished
        }
    } catch (error) {
        return failed(ctx.hooks, "membership", "membershipStatus", error)
    }
}
