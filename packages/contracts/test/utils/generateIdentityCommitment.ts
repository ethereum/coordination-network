import { Identity } from "@semaphore-protocol/identity"
import { encodeAbiParameters } from "viem"

const main = async () => {
    const privateKey = process.argv[2]
    const identity = new Identity(privateKey)

    const encodedIdentityCommitment = encodeAbiParameters(
        [{ name: "merkleTreeDepth", type: "uint256" }],
        [identity.commitment]
    )
    process.stdout.write(encodedIdentityCommitment)
    process.exit(0)
}

main().catch((error) => {
    console.error("generateIdentityCommitment.ts error:", error)
    process.exit(1)
})
