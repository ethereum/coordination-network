import type { Hex32 } from "@coordination-network/user-app-link"
import type { DeliverOutcome } from "../outcomes"
import type { MemberContext } from "../context"
import { failed, runHook } from "./shared"

export interface DeliverInput {
    networkId: Hex32
}

export async function deliver(ctx: MemberContext, input: DeliverInput): Promise<DeliverOutcome> {
    try {
        const result = await ctx.server.deliver({ networkId: input.networkId })

        const outcome: Extract<DeliverOutcome, { status: "announced" }> = {
            status: "announced",
            networkId: input.networkId,
            txHash: result.txHash
        }
        await runHook(ctx.hooks, "deliver", "deliveries", () => ctx.hooks?.onDelivered?.(outcome))
        return outcome
    } catch (error) {
        return failed(ctx.hooks, "deliver", "deliveries", error)
    }
}
