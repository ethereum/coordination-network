import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { verifyProof } from "@semaphore-protocol/proof"
import { getCurveFromName, type Curve } from "ffjavascript"
import { generateSemaphoreProof } from "../src/generate-semaphore-proof"
import { randomScope, updateDomainSeparator, updateMessage } from "../src/message"
import { IdentityUpdate, RegistryLocation, UpdateAction } from "../src/types"

const REGISTRY: RegistryLocation = { chainId: 31337n, address: "0x00000000000000000000000000000000000a1DE1" }

const NETWORK_ID_A = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const NETWORK_ID_B = "0x2222222222222222222222222222222222222222222222222222222222222222" as const
const META_A = `0x02${"11".repeat(32)}03${"22".repeat(32)}` as const

const registerA: IdentityUpdate = {
    action: UpdateAction.Register,
    networkId: NETWORK_ID_A,
    metaStealthAddress: META_A
}

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

describe("the update message", () => {
    it("separates deployments by registry address", () => {
        expect(updateDomainSeparator(REGISTRY.address)).not.toBe(
            updateDomainSeparator("0x000000000000000000000000000000000000dEaD")
        )
    })

    it("differs per action, networkId, payload, chain and registry", () => {
        const message = updateMessage(REGISTRY, registerA)

        expect(updateMessage(REGISTRY, { ...registerA, action: UpdateAction.Update })).not.toBe(message)
        expect(updateMessage(REGISTRY, { ...registerA, networkId: NETWORK_ID_B })).not.toBe(message)
        expect(updateMessage(REGISTRY, { ...registerA, metaStealthAddress: "0x02" })).not.toBe(message)
        // A registry does not own its group, so two deployments can share one: the chain id and the
        // registry address are what keep a proof from being usable at the other.
        expect(updateMessage({ ...REGISTRY, chainId: 1n }, registerA)).not.toBe(message)
        expect(
            updateMessage({ ...REGISTRY, address: "0x000000000000000000000000000000000000dEaD" }, registerA)
        ).not.toBe(message)
    })

    it("refuses to leave a registration or update without a payload", () => {
        expect(() => updateMessage(REGISTRY, { action: UpdateAction.Register, networkId: NETWORK_ID_A })).toThrow(
            "a registration or update binds a meta-stealth address"
        )
    })

    it("refuses to bind a payload into a removal", () => {
        expect(() =>
            updateMessage(REGISTRY, {
                action: UpdateAction.Remove,
                networkId: NETWORK_ID_A,
                metaStealthAddress: META_A
            })
        ).toThrow("a removal binds no meta-stealth address")
    })
})

describe("the proof scope", () => {
    it("is a fresh field element every time", () => {
        const scopes = new Set(Array.from({ length: 16 }, () => randomScope()))

        expect(scopes.size).toBe(16)
        for (const scope of scopes) {
            expect(scope).toBeGreaterThan(0n)
            expect(scope).toBeLessThan(2n ** 248n)
        }
    })
})

describe("generating a proof", () => {
    it("produces a proof the Semaphore verifier accepts, bound to the update", async () => {
        const proof = await generateSemaphoreProof({
            identity: memberOne,
            group,
            registry: REGISTRY,
            update: registerA
        })

        expect(proof.merkleTreeRoot).toBe(group.root)
        expect(proof.points).toHaveLength(8)
        // The proof carries no message: the registry supplies it, so verification here has to
        // reproduce it the same way the contract does.
        await expect(
            verifyProof({
                merkleTreeDepth: Number(proof.merkleTreeDepth),
                merkleTreeRoot: proof.merkleTreeRoot.toString(),
                nullifier: proof.nullifier.toString(),
                message: updateMessage(REGISTRY, registerA).toString(),
                scope: proof.scope.toString(),
                points: proof.points.map(String) as never
            })
        ).resolves.toBe(true)
    })

    it("gives the same member an unlinkable nullifier per proof", async () => {
        const [first, second, pinned, pinnedAgain] = await Promise.all([
            generateSemaphoreProof({ identity: memberOne, group, registry: REGISTRY, update: registerA }),
            generateSemaphoreProof({ identity: memberOne, group, registry: REGISTRY, update: registerA }),
            generateSemaphoreProof({ identity: memberOne, group, registry: REGISTRY, update: registerA, scope: 1n }),
            generateSemaphoreProof({
                identity: memberOne,
                group,
                registry: REGISTRY,
                update: { action: UpdateAction.Remove, networkId: NETWORK_ID_B },
                scope: 1n
            })
        ])

        expect(second.nullifier).not.toBe(first.nullifier)
        // The nullifier is poseidon(secret, scope): fixing the scope fixes it, whatever the update
        // says, which is what makes a resubmitted proof a spent nullifier on chain.
        expect(pinnedAgain.nullifier).toBe(pinned.nullifier)
    })

    it("gives different members different nullifiers on the same scope", async () => {
        const [fromOne, fromTwo] = await Promise.all([
            generateSemaphoreProof({ identity: memberOne, group, registry: REGISTRY, update: registerA, scope: 1n }),
            generateSemaphoreProof({ identity: memberTwo, group, registry: REGISTRY, update: registerA, scope: 1n })
        ])

        expect(fromTwo.nullifier).not.toBe(fromOne.nullifier)
    })

    // A member the group no longer holds cannot even build a proof against it: the on-chain
    // rejection tested in Solidity is the second line of defence, not the first.
    it("cannot be generated by a member the group no longer holds", async () => {
        const withoutMemberTwo = new Group([memberOne.commitment, memberTwo.commitment])
        withoutMemberTwo.removeMember(withoutMemberTwo.indexOf(memberTwo.commitment))

        await expect(
            generateSemaphoreProof({
                identity: memberTwo,
                group: withoutMemberTwo,
                registry: REGISTRY,
                update: registerA
            })
        ).rejects.toThrow()
    })
})
