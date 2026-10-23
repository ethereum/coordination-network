import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof, verifyProof } from "@semaphore-protocol/proof"
import { encodeAbiParameters } from "viem"

const main = async () => {
    const sender = process.argv[2]
    const privateKey = process.argv[3]

    const identity = new Identity(privateKey)
    const group = new Group([identity.commitment])
    const message = BigInt(sender)
    const scope = BigInt(sender)

    const proof = await generateProof(identity, group, message, scope)
    const verified = await verifyProof(proof)
    if (!verified) {
        throw new Error("INVALID PROOF")
    }

    const encodedProof = encodeAbiParameters(
        [
            { name: "merkleTreeDepth", type: "uint256" },
            { name: "merkleTreeRoot", type: "uint256" },
            { name: "nullifier", type: "uint256" },
            { name: "message", type: "uint256" },
            { name: "scope", type: "uint256" },
            { name: "points", type: "uint256[8]" }
        ],
        [BigInt(proof.merkleTreeDepth), proof.merkleTreeRoot, proof.nullifier, proof.message, proof.scope, proof.points]
    )
    process.stdout.write(encodedProof)
    process.exit(0)
}

main().catch((error) => {
    console.error("generateSemaphoreProof.ts error:", error)
    process.exit(1)
})
