import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { generateProof } from "@semaphore-protocol/proof"
import { encodeAbiParameters, type Address, type Hex } from "viem"

const SEMAPHORE_PROOF_ABI = [
    { name: "merkleTreeDepth", type: "uint256" },
    { name: "merkleTreeRoot", type: "uint256" },
    { name: "nullifier", type: "uint256" },
    { name: "message", type: "uint256" },
    { name: "scope", type: "uint256" },
    { name: "points", type: "uint256[8]" }
] as const

export async function generatePaymasterProof({
    identity,
    group,
    sender
}: {
    identity: Identity
    group: Group
    sender: Address
}): Promise<Hex> {
    const senderAsField = BigInt(sender)
    const message = senderAsField
    const scope = senderAsField
    const proof = await generateProof(identity, group, message, scope)
    return encodeAbiParameters(SEMAPHORE_PROOF_ABI, [
        BigInt(proof.merkleTreeDepth),
        proof.merkleTreeRoot,
        proof.nullifier,
        proof.message,
        proof.scope,
        proof.points
    ])
}
