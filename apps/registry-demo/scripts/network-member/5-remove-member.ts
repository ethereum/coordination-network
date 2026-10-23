import type { HDAccount } from "viem/accounts"
import { buildRemovalTransaction } from "@coordination-network/network-member-governance"
import type { NetworkMemberDeployment } from "../deploy/network-member.ts"
import { rebuildGroupFromChain, siblingsFor } from "../shared/semaphore-group.ts"
import type { Member } from "../shared/personas.ts"
import { approveAndExecute, readSafeState } from "../shared/safe.ts"

/**
 * Step 5. A majority removes a member.
 *
 * Admission in reverse and just as atomic: record, group leaf, seat and issuer keys all go together,
 * and the threshold comes down. Retiring the keys is why the issuer set must be wired before anyone is
 * admitted, since a removed member with live keys could keep issuing credentials that verify.
 *
 * Only the networkId and the proof are passed; the orchestrator reads the commitment and the signer
 * from the registry, so a removal cannot be pointed at another member.
 */
export async function removeMember(deployment: NetworkMemberDeployment, member: Member, approvers: HDAccount[]) {
    const { nonce, owners } = await readSafeState(deployment.safe)

    // Rebuilt here, immediately before the proof is computed from it, so the proof is against the group
    // as the chain currently holds it.
    const group = await rebuildGroupFromChain(deployment)

    const transaction = buildRemovalTransaction(
        { governance: deployment.governance, registry: deployment.registry },
        {
            memberNetworkId: member.networkId,
            // Valid against the group state this transaction will execute in. Another membership change
            // landing first invalidates it, and the removal has to be rebuilt and re-approved.
            merkleProofSiblings: siblingsFor(group, member.identity.commitment)
        },
        deployment.context,
        nonce,
        owners.length
    )

    return approveAndExecute(deployment.context, transaction, approvers)
}
