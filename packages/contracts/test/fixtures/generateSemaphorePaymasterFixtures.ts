import { writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Identity } from "@semaphore-protocol/identity"
import { Group } from "@semaphore-protocol/group"
import { generateProof } from "@semaphore-protocol/proof"
import { encodeAbiParameters, keccak256, numberToHex, stringToHex, type Address } from "viem"
import { privateKeyToAccount } from "viem/accounts"

// Regenerate with: node test/fixtures/generateSemaphorePaymasterFixtures.ts

// Same derivation as foundry's makeAddr(name)
const makeAddr = (name: string): Address => privateKeyToAccount(keccak256(stringToHex(name))).address

const sender1 = makeAddr("sender1")
const sender2 = makeAddr("sender2")

const member1 = new Identity("member1")
const member2 = new Identity("member2")
const nonMember = new Identity("non-member")

type ProofArgs = {
    identity: Identity
    group: Group
    message: Address
    scope: Address
}

const generateEncodedProof = async ({ identity, group, message, scope }: ProofArgs) => {
    const proof = await generateProof(identity, group, BigInt(message), BigInt(scope))
    return encodeAbiParameters(
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
}

const main = async () => {
    const fullGroup = new Group([member1.commitment, member2.commitment])
    const member1OnlyGroup = new Group([member1.commitment])
    const foreignGroup = new Group([nonMember.commitment])

    const fixtures = {
        member1Commitment: numberToHex(member1.commitment, { size: 32 }),
        member2Commitment: numberToHex(member2.commitment, { size: 32 }),
        validProof: await generateEncodedProof({
            identity: member1,
            group: fullGroup,
            message: sender1,
            scope: sender1
        }),
        wrongScopeProof: await generateEncodedProof({
            identity: member1,
            group: fullGroup,
            message: sender1,
            scope: sender2
        }),
        // A valid proof whose root is a group containing 1 member.
        // Tests add member 1 (creating exactly that root), then member 2 (replacing it),
        // so this proof's root becomes "superseded". Accepted for merkleTreeDuration.
        supersededRootProof: await generateEncodedProof({
            identity: member1,
            group: member1OnlyGroup,
            message: sender1,
            scope: sender1
        }),
        nonMemberProof: await generateEncodedProof({
            identity: nonMember,
            group: foreignGroup,
            message: sender1,
            scope: sender1
        })
    }

    const outputPath = join(dirname(fileURLToPath(import.meta.url)), "semaphorePaymasterProofs.json")
    writeFileSync(outputPath, `${JSON.stringify(fixtures, null, 4)}\n`)

    // eslint-disable-next-line no-console
    console.log(`Wrote ${outputPath}`)
    process.exit(0)
}

main().catch((error) => {
    console.error("generateSemaphorePaymasterFixtures.ts error:", error)
    process.exit(1)
})
