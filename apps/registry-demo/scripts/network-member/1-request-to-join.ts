import {
    NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
    decodeJoinRequestLog,
    encodeRequestToJoin,
    type NetworkMemberJoinRequest
} from "@coordination-network/network-member-governance"
import { publicClient, send } from "../shared/config.ts"
import type { NetworkMemberDeployment } from "../deploy/network-member.ts"
import type { Member } from "../shared/personas.ts"

/**
 * Step 1. The candidate announces itself.
 *
 * Permissionless and worth nothing: the registry stores nothing and emits an event. The only check is
 * that the sender is the address of the account key it announces, which is why this is the one step the
 * Safe has no part in.
 */
export async function requestToJoin(deployment: NetworkMemberDeployment, member: Member) {
    return send({
        account: member.auth,
        to: deployment.registry,
        data: encodeRequestToJoin({
            memberNetworkId: member.networkId,
            accountKeyX: member.accountKeyX,
            accountKeyY: member.accountKeyY,
            semaphoreCommitment: member.identity.commitment,
            governanceSigner: member.governanceSigner.address,
            metadataURI: member.metadataURI
        })
    })
}

/**
 * Reads the candidate's request back off the chain, the way an approver does: from the candidate's own
 * event, never from a payload somebody sent. That is what makes the approval mean something, since the
 * digest covers exactly the fields decoded here.
 */
export async function readJoinRequest(
    deployment: NetworkMemberDeployment,
    member: Member
): Promise<NetworkMemberJoinRequest> {
    const logs = await publicClient.getLogs({
        address: deployment.registry,
        event: NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
        args: { memberNetworkId: member.networkId },
        fromBlock: 0n
    })

    // A candidate may publish several requests before it is admitted, so real vetting code picks the
    // request it actually approved rather than simply the newest. The demo publishes one.
    const [log] = logs
    if (!log) throw new Error(`no join request on chain for ${member.name}`)

    return decodeJoinRequestLog(log, deployment.registry)
}
