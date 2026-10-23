import type { MemberContext } from "../context"
import type { RevokeOutcome } from "../outcomes"
import { failed, runHook } from "./shared"

export interface RevokeInput {
    credentialId: string
}

export async function revoke(ctx: MemberContext, input: RevokeInput): Promise<RevokeOutcome> {
    try {
        await ctx.server.revokeCredential(input.credentialId)

        const outcome: Extract<RevokeOutcome, { status: "revoked" }> = {
            status: "revoked",
            credentialId: input.credentialId
        }
        await runHook(ctx.hooks, "revoke", "revoke", () => ctx.hooks?.onRevoked?.(outcome))
        return outcome
    } catch (error) {
        return failed(ctx.hooks, "revoke", "revoke", error)
    }
}
