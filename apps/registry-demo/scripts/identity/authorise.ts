import {
    generateSemaphoreProof,
    UpdateAction,
    type NetworkMemberProof
} from "@coordination-network/network-member-proof"
import type { Hex } from "viem"
import { publicClient } from "../shared/config.ts"
import type { Member } from "../shared/personas.ts"
import { rebuildGroupFromChain } from "../shared/semaphore-group.ts"
import type { IdentityDeployment } from "../deploy/identity.ts"

/**
 * Produces the membership proof one identity registry write needs, as an approved member.
 *
 * The proof says an approved member authorised this exact update: not which member, and not who
 * submits it. It is bound to the action, the networkId, the meta-stealth address, the registry's
 * address and the chain id, so it authorises one call and nothing else. A proof built for a register
 * cannot be replayed as an update, nor against another payload, nor at another deployment.
 *
 * The group is rebuilt from the chain for every proof, because a proof is checked against a root the
 * group actually held. Semaphore accepts a superseded root for the group's tree duration, so a stale
 * mirror would work for an hour and then quietly stop.
 */
export async function authoriseUpdate(
    deployment: IdentityDeployment,
    member: Member,
    update: { action: UpdateAction; networkId: Hex; metaStealthAddress?: Hex }
): Promise<NetworkMemberProof> {
    return generateSemaphoreProof({
        identity: member.identity,
        group: await rebuildGroupFromChain(deployment),
        registry: { chainId: BigInt(publicClient.chain.id), address: deployment.identityRegistry },
        update
    })
}
