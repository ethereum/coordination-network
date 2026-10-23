import type { HDAccount } from "viem/accounts"
import { buildAdmissionTransaction } from "@coordination-network/network-member-governance"
import type { NetworkMemberDeployment } from "../deploy/network-member.ts"
import type { Member } from "../shared/personas.ts"
import { approveAndExecute, readSafeState } from "../shared/safe.ts"
import { readJoinRequest } from "./1-request-to-join.ts"

/**
 * Step 2. A majority of the current members admits the candidate.
 *
 * One call writing all three contracts a member exists in, together or not at all. The threshold is
 * not in the calldata: the orchestrator computes it from the Safe's live owner count, so an approver
 * cannot be shown a lowered one.
 *
 * @param approvers The owners approving, the last of which executes.
 */
export async function admitMember(deployment: NetworkMemberDeployment, member: Member, approvers: HDAccount[]) {
    const admission = await readJoinRequest(deployment, member)
    const { nonce, owners } = await readSafeState(deployment.safe)

    const transaction = buildAdmissionTransaction(
        { governance: deployment.governance, registry: deployment.registry },
        admission,
        deployment.context,
        nonce,
        // Pinned, so the transaction goes stale if the member set changes before it executes. A
        // voluntary exit can shrink that set without advancing the Safe's nonce.
        owners.length
    )

    return approveAndExecute(deployment.context, transaction, approvers)
}
