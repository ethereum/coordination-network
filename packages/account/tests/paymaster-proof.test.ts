import { afterAll, beforeAll, describe, expect, it } from "@jest/globals"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { verifyProof } from "@semaphore-protocol/proof"
import { getCurveFromName, type Curve } from "ffjavascript"
import { decodeAbiParameters, type Address } from "viem"
import { generatePaymasterProof } from "../src/paymaster-proof"

const PAYMASTER_DATA_ABI = [
    { name: "merkleTreeDepth", type: "uint256" },
    { name: "merkleTreeRoot", type: "uint256" },
    { name: "nullifier", type: "uint256" },
    { name: "message", type: "uint256" },
    { name: "scope", type: "uint256" },
    { name: "points", type: "uint256[8]" }
] as const

const MEMBER = new Identity("member")
const GROUP = new Group([MEMBER.commitment, new Identity("other member").commitment])
const SENDER: Address = "0x00000000000000000000000000000000000000ab"
const OTHER_SENDER: Address = "0x00000000000000000000000000000000000000cd"

describe("generatePaymasterProof", () => {
    // snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
    let curve: Curve

    beforeAll(async () => {
        curve = await getCurveFromName("bn128")
    })

    afterAll(async () => {
        await curve.terminate()
    })

    it("encodes a valid proof of membership in the group, bound to the sender", async () => {
        const paymasterData = await generatePaymasterProof({ identity: MEMBER, group: GROUP, sender: SENDER })
        const [merkleTreeDepth, merkleTreeRoot, nullifier, message, scope, points] = decodeAbiParameters(
            PAYMASTER_DATA_ABI,
            paymasterData
        )

        expect(merkleTreeDepth).toBe(BigInt(GROUP.depth))
        expect(merkleTreeRoot).toBe(GROUP.root)
        expect(message).toBe(BigInt(SENDER))
        expect(scope).toBe(BigInt(SENDER))
        expect(
            await verifyProof({
                merkleTreeDepth: Number(merkleTreeDepth),
                merkleTreeRoot: merkleTreeRoot.toString(),
                nullifier: nullifier.toString(),
                message: message.toString(),
                scope: scope.toString(),
                points: points.map(String) as [string, string, string, string, string, string, string, string]
            })
        ).toBe(true)
    })

    it("produces a different nullifier for each sender, so one identity's accounts do not link", async () => {
        const [, , nullifier, message] = decodeAbiParameters(
            PAYMASTER_DATA_ABI,
            await generatePaymasterProof({ identity: MEMBER, group: GROUP, sender: SENDER })
        )
        const [, , otherNullifier, otherMessage] = decodeAbiParameters(
            PAYMASTER_DATA_ABI,
            await generatePaymasterProof({ identity: MEMBER, group: GROUP, sender: OTHER_SENDER })
        )

        expect(message).toBe(BigInt(SENDER))
        expect(otherMessage).toBe(BigInt(OTHER_SENDER))
        expect(otherNullifier).not.toBe(nullifier)
    })
})
