import { encodeExitNetwork } from "@coordination-network/network-member-governance"
import { send } from "../shared/config.ts"
import type { NetworkMemberDeployment } from "../deploy/network-member.ts"
import { rebuildGroupFromChain, siblingsFor } from "../shared/semaphore-group.ts"
import type { Member } from "../shared/personas.ts"

/**
 * Step 6. A member leaves of its own accord.
 *
 * The one operation that does not go through the Safe, because departure should not need the consent
 * of the members being left. Only the member's own governance signer can call it, so a stolen signer
 * reaches that member's membership and no other. It clears the same three contracts a removal does.
 */
export async function exitNetwork(deployment: NetworkMemberDeployment, member: Member) {
    const group = await rebuildGroupFromChain(deployment)

    return send({
        account: member.governanceSigner,
        to: deployment.governance,
        data: encodeExitNetwork(member.networkId, siblingsFor(group, member.identity.commitment))
    })
}
