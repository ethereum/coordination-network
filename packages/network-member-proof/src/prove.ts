import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { generateProof } from "@semaphore-protocol/proof"
import { NetworkMemberProof } from "./types"

/**
 * Proves membership over an already derived message, in the shape a NetworkMemberGate expects.
 *
 * The message is absent from the result: the gated contract derives it from the call's own arguments,
 * so submitting a proof means submitting the payload it was generated for.
 */
export async function proveMessage(
    identity: Identity,
    group: Group,
    message: bigint,
    scope: bigint
): Promise<NetworkMemberProof> {
    const proof = await generateProof(identity, group, message, scope)

    return {
        merkleTreeDepth: BigInt(proof.merkleTreeDepth),
        merkleTreeRoot: BigInt(proof.merkleTreeRoot),
        nullifier: BigInt(proof.nullifier),
        scope: BigInt(proof.scope),
        points: proof.points.map(BigInt) as unknown as NetworkMemberProof["points"]
    }
}
