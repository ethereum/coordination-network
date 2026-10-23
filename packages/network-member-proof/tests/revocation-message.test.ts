import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { verifyProof } from "@semaphore-protocol/proof"
import { getCurveFromName, type Curve } from "ffjavascript"
import { generateRevocationProof } from "../src/generate-revocation-proof"
import { revocationDomainSeparator, revocationMessage } from "../src/revocation-message"
import { RegistryLocation, RevocationAction, RevocationUpdate } from "../src/types"

const REGISTRY: RegistryLocation = { chainId: 31337n, address: "0x0000000000000000000000000000000000feed01" }

const COMMITMENT_A = 111n
const COMMITMENT_B = 222n

const revokeA: RevocationUpdate = { action: RevocationAction.Revoke, revocationCommitment: COMMITMENT_A }

const memberOne = new Identity("member-one")
const memberTwo = new Identity("member-two")
const group = new Group([memberOne.commitment, memberTwo.commitment])

// snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
let curve: Curve

beforeAll(async () => {
    curve = await getCurveFromName("bn128")
})

afterAll(async () => {
    await curve.terminate()
})

describe("the revocation message", () => {
    it("separates deployments by registry address", () => {
        expect(revocationDomainSeparator(REGISTRY.address)).not.toBe(
            revocationDomainSeparator("0x000000000000000000000000000000000000dead")
        )
    })

    it("differs per action, commitment, chain and registry", () => {
        const message = revocationMessage(REGISTRY, revokeA)

        expect(
            revocationMessage(REGISTRY, { action: RevocationAction.Unrevoke, revocationCommitment: COMMITMENT_A })
        ).not.toBe(message)
        expect(
            revocationMessage(REGISTRY, { action: RevocationAction.Revoke, revocationCommitment: COMMITMENT_B })
        ).not.toBe(message)
        // The registry does not own its group, so the chain id and address are what keep a proof from
        // being usable at another deployment.
        expect(revocationMessage({ ...REGISTRY, chainId: 1n }, revokeA)).not.toBe(message)
        expect(
            revocationMessage({ ...REGISTRY, address: "0x000000000000000000000000000000000000dead" }, revokeA)
        ).not.toBe(message)
    })

    // A one-commitment batch packs exactly like a single revocation, so only the action keeps a
    // `revoke` proof from authorising a `revokeMany`.
    it("distinguishes a single revocation from a one-commitment batch", () => {
        expect(
            revocationMessage(REGISTRY, {
                action: RevocationAction.RevokeMany,
                revocationCommitments: [COMMITMENT_A]
            })
        ).not.toBe(revocationMessage(REGISTRY, revokeA))
    })

    it("binds a batch in order", () => {
        const forwards = revocationMessage(REGISTRY, {
            action: RevocationAction.RevokeMany,
            revocationCommitments: [COMMITMENT_A, COMMITMENT_B]
        })
        const backwards = revocationMessage(REGISTRY, {
            action: RevocationAction.RevokeMany,
            revocationCommitments: [COMMITMENT_B, COMMITMENT_A]
        })

        // Each index describes the state the earlier commitments leave behind, so the order is part
        // of what a member authorises.
        expect(forwards).not.toBe(backwards)
    })

    it("binds both commitments of a replacement", () => {
        const message = revocationMessage(REGISTRY, {
            action: RevocationAction.UpdateCommitment,
            oldRevocationCommitment: COMMITMENT_A,
            newRevocationCommitment: COMMITMENT_B
        })

        expect(
            revocationMessage(REGISTRY, {
                action: RevocationAction.UpdateCommitment,
                oldRevocationCommitment: COMMITMENT_B,
                newRevocationCommitment: COMMITMENT_A
            })
        ).not.toBe(message)
    })

    it("refuses an empty batch", () => {
        expect(() =>
            revocationMessage(REGISTRY, { action: RevocationAction.RevokeMany, revocationCommitments: [] })
        ).toThrow("a batch binds at least one commitment")
    })
})

describe("generating a revocation proof", () => {
    it("produces a proof the Semaphore verifier accepts, bound to the revocation", async () => {
        const proof = await generateRevocationProof({
            identity: memberOne,
            group,
            registry: REGISTRY,
            update: revokeA
        })

        await expect(
            verifyProof({
                merkleTreeDepth: Number(proof.merkleTreeDepth),
                merkleTreeRoot: proof.merkleTreeRoot.toString(),
                nullifier: proof.nullifier.toString(),
                message: revocationMessage(REGISTRY, revokeA).toString(),
                scope: proof.scope.toString(),
                points: proof.points.map(String) as never
            })
        ).resolves.toBe(true)
    }, 60_000)

    it("does not verify against another revocation's message", async () => {
        const proof = await generateRevocationProof({
            identity: memberTwo,
            group,
            registry: REGISTRY,
            update: revokeA
        })

        await expect(
            verifyProof({
                merkleTreeDepth: Number(proof.merkleTreeDepth),
                merkleTreeRoot: proof.merkleTreeRoot.toString(),
                nullifier: proof.nullifier.toString(),
                message: revocationMessage(REGISTRY, {
                    action: RevocationAction.Revoke,
                    revocationCommitment: COMMITMENT_B
                }).toString(),
                scope: proof.scope.toString(),
                points: proof.points.map(String) as never
            })
        ).resolves.toBe(false)
    }, 60_000)
})
