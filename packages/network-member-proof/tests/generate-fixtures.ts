/**
 * Regenerates the real Semaphore proofs the Solidity tests verify against, into
 * `packages/contracts/test/fixtures/network-member-proofs.json`.
 *
 * Run with `yarn workspace @coordination-network/network-member-proof generate:fixtures`. The
 * Solidity side pins the chain id and deploys the registry to `REGISTRY.address`, because both are
 * bound into every message. Scopes are fixed here rather than random, so
 * the fixtures are reproducible; a real client leaves `scope` alone and gets a fresh random one per
 * proof.
 */
import { writeFileSync } from "fs"
import { join } from "path"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { generateSemaphoreProof } from "../src/generate-semaphore-proof"
import { updateDomainSeparator } from "../src/message"
import { IdentityUpdate, NetworkMemberProof, RegistryLocation, UpdateAction } from "../src/types"

/** Forge's default chain id and the address the Solidity tests deploy the registry to. */
const REGISTRY: RegistryLocation = {
    chainId: 31337n,
    address: "0x00000000000000000000000000000000000a1DE1"
}

const MEMBER_SECRETS = ["member-one", "member-two", "member-three"] as const
const NEWCOMER_SECRET = "member-four"
const OUTSIDER_SECRET = "not-a-member"

const NETWORK_ID_A = "0x1111111111111111111111111111111111111111111111111111111111111111" as const
const NETWORK_ID_B = "0x2222222222222222222222222222222222222222222222222222222222222222" as const
const META_A = `0x02${"11".repeat(32)}03${"22".repeat(32)}` as const
const META_B = `0x02${"33".repeat(32)}03${"44".repeat(32)}` as const

const identities = MEMBER_SECRETS.map((secret) => new Identity(secret))
const newcomer = new Identity(NEWCOMER_SECRET)
const outsider = new Identity(OUTSIDER_SECRET)

const commitments = identities.map((identity) => identity.commitment)
const initialGroup = new Group(commitments)
const outsiderGroup = new Group([...commitments, outsider.commitment])

const registerA: IdentityUpdate = {
    action: UpdateAction.Register,
    networkId: NETWORK_ID_A,
    metaStealthAddress: META_A
}
const registerB: IdentityUpdate = {
    action: UpdateAction.Register,
    networkId: NETWORK_ID_B,
    metaStealthAddress: META_B
}
const updateA: IdentityUpdate = { action: UpdateAction.Update, networkId: NETWORK_ID_A, metaStealthAddress: META_B }
const removeA: IdentityUpdate = { action: UpdateAction.Remove, networkId: NETWORK_ID_A }

async function proofFor(
    identityIndex: number | "outsider",
    group: Group,
    update: IdentityUpdate,
    scope: bigint
): Promise<NetworkMemberProof> {
    const identity = identityIndex === "outsider" ? outsider : identities[identityIndex]

    return generateSemaphoreProof({ identity, group, registry: REGISTRY, update, scope })
}

async function main() {
    const fixtures = {
        registry: REGISTRY.address,
        chainId: Number(REGISTRY.chainId),
        updateDomainSeparator: updateDomainSeparator(REGISTRY.address),
        memberCommitments: commitments,
        newcomerCommitment: newcomer.commitment,
        networkIdA: NETWORK_ID_A,
        networkIdB: NETWORK_ID_B,
        metaA: META_A,
        metaB: META_B,
        proofs: {
            // Member 0 registers networkId A. The workhorse fixture.
            registerA: await proofFor(0, initialGroup, registerA, 1n),
            // Member 1 registers networkId A: same payload as registerA, different member, so the
            // nullifier is not what makes registerA unique.
            registerAByMemberOne: await proofFor(1, initialGroup, registerA, 3n),
            // Member 0 again, on a fresh scope: an unlinkable second update by the same member.
            registerBAgain: await proofFor(0, initialGroup, registerB, 4n),
            // Member 1 updates networkId A's meta-stealth address.
            updateA: await proofFor(1, initialGroup, updateA, 5n),
            // Member 2 removes networkId A.
            removeA: await proofFor(2, initialGroup, removeA, 6n),
            // Member 2, still in the group at proof time, is removed from it before submitting.
            removedMemberRegisterB: await proofFor(2, initialGroup, registerB, 7n),
            // A well-formed proof against a group this registry never had.
            foreignGroupRegisterA: await proofFor("outsider", outsiderGroup, registerA, 8n)
        }
    }

    const path = join(__dirname, "../../contracts/test/fixtures/network-member-proofs.json")
    const json = JSON.stringify(
        fixtures,
        (_key, value) => (typeof value === "bigint" ? `0x${value.toString(16)}` : value),
        4
    )

    writeFileSync(path, `${json}\n`)

    // eslint-disable-next-line no-console
    console.log(`wrote ${path}`)
    process.exit(0)
}

main()
