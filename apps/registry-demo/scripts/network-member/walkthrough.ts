import type { ChildProcess } from "node:child_process"
import { governanceThreshold } from "@coordination-network/network-member-governance"
import { startAnvil } from "../shared/chain.ts"
import { RPC_URL } from "../shared/config.ts"
import { deployNetworkMemberStack } from "../deploy/network-member.ts"
import { rebuildGroupFromChain } from "../shared/semaphore-group.ts"
import { alice, bob, founders, metaStealthAddressFor } from "../shared/personas.ts"
import { check, endNarration, fact, pause, printSafeState, section, short, step } from "../shared/narrate.ts"
import { readSafeState } from "../shared/safe.ts"
import { readJoinRequest, requestToJoin } from "./1-request-to-join.ts"
import { admitMember } from "./2-admit-member.ts"
import { isModuleEnabled, issuerSetIsWired, printMemberState, readMember } from "./3-read-member.ts"
import { registerMemberIdentity } from "./4-register-member-identity.ts"
import { removeMember } from "./5-remove-member.ts"
import { exitNetwork } from "./6-exit-network.ts"

const ALICE_DEVICE_SECRET = `0x${"01".repeat(32)}` as const
const ALICE_ROTATED_SECRET = `0x${"02".repeat(32)}` as const
const BOB_DEVICE_SECRET = `0x${"03".repeat(32)}` as const

/**
 * The network member registry, walked through from a founding network to a member joining, publishing
 * its address, being removed, and leaving.
 *
 * Narrated as it goes, and checked as it goes: every `check` here reads state back from the chain and
 * throws if it is not what the narration just claimed. That is what lets this be both the demo and its
 * own regression test, rather than a script that can print a success it did not have.
 *
 * What it deliberately does not do is re-prove the contracts. Authorisation, the threshold rule and the
 * atomicity of each operation are covered by the Solidity suites in `packages/contracts/test`, and the
 * transaction building by the unit tests in `packages/network-member-governance`. This exercises the
 * part neither can: that those builders work against a real Safe and a real Semaphore group over a
 * live connection.
 */
export async function runNetworkMemberWalkthrough() {
    let anvil: ChildProcess | undefined

    try {
        section(
            "A founding network",
            `Starting Anvil on ${RPC_URL}, deploying the governance stack, and admitting the ${founders.length}\n` +
                "founding members: their records, their group leaves and their seats at the Safe."
        )
        anvil = await startAnvil()

        const deployment = await deployNetworkMemberStack()

        fact("governance Safe", short(deployment.safe))
        fact("member registry", short(deployment.registry))
        fact("member group", short(deployment.group))
        fact("orchestrator", short(deployment.governance))
        fact("approved issuer set", short(deployment.issuerSet))

        const founding = await readSafeState(deployment.safe)
        printSafeState(founding)
        check(
            founding.threshold === governanceThreshold(founding.owners.length),
            "the founding Safe requires a majority of its members"
        )

        // The two wiring calls the rest of the flow silently depends on. Without the module the Safe
        // cannot reach its own owner set, and without the issuer set no member can be admitted at all,
        // so both are worth reading back rather than assuming the deployment did them.
        check(await isModuleEnabled(deployment), "the orchestrator is enabled as a Safe module")
        check(await issuerSetIsWired(deployment), "the approved-issuer set is wired to the registry")
        // Genesis wrote the founders into the same three contracts an admission writes, so the network
        // starts as a real founding network rather than as a Safe whose owners are members of nothing.
        const genesisGroup = await rebuildGroupFromChain(deployment)
        const foundingRecords = await Promise.all(founders.map((founder) => readMember(deployment, founder)))
        check(
            foundingRecords.every((record) => record.approved && record.inGroup && record.isSafeOwner),
            "each founding member holds a record, a group leaf and a Safe seat"
        )
        check(
            founders.every((founder, index) => genesisGroup.indexOf(founder.identity.commitment) === index),
            "their leaves take the first slots, in the order genesis admitted them"
        )
        check(
            foundingRecords.every((record) => record.metaStealthAddress === "0x"),
            "and none has published a meta-stealth address, which genesis does not write"
        )
        await pause()

        step(
            "1",
            "Alice asks to join",
            "Permissionless, and it grants nothing: the registry stores nothing and emits the event the\n" +
                "approved members watch. The one check is that the sender is the address her networkId encodes."
        )
        await requestToJoin(deployment, alice)

        const request = await readJoinRequest(deployment, alice)
        fact("networkId", short(request.memberNetworkId))
        fact("semaphore commitment", short(request.semaphoreCommitment))
        fact("governance signer", short(request.governanceSigner))
        fact("vetting material", request.metadataURI ?? "")
        check(!(await readMember(deployment, alice)).approved, "asking to join approved nobody")
        await pause()

        step(
            "2",
            "Two of the three founding members admit her",
            "Nothing is passed between approvers: each rebuilds the transaction from her request on chain\n" +
                "and approves that hash, so nobody signs bytes someone else assembled.\n" +
                "One call writes the three contracts a member exists in, so they cannot come apart: her record,\n" +
                "her leaf in the Semaphore group, and her governance signer as a Safe owner.\n" +
                "No meta-stealth address among them. She publishes that herself, in step 4."
        )
        await admitMember(deployment, alice, [founders[0].governanceSigner, founders[1].governanceSigner])

        const aliceState = await readMember(deployment, alice)
        printMemberState("Alice", aliceState)
        const afterAlice = await readSafeState(deployment.safe)
        printSafeState(afterAlice)
        check(
            aliceState.semaphoreCommitment === request.semaphoreCommitment &&
                aliceState.governanceSigner === request.governanceSigner,
            "her record holds the commitment and signer she asked to join with"
        )
        check(afterAlice.owners.length === founding.owners.length + 1, "Alice is now an approver herself")
        check(afterAlice.threshold === governanceThreshold(afterAlice.owners.length), "the threshold moved with her")
        check(
            (await rebuildGroupFromChain(deployment)).indexOf(alice.identity.commitment) === founders.length,
            "her leaf sits after the founding members', in the order the group grew"
        )
        await pause()

        step(
            "3",
            "Alice votes on the next candidate",
            "Bob asks to join, and Alice's governance signer is one of the three signatures he now needs.\n" +
                "Admission is what makes a member an approver, so the set that governs grows with the network."
        )
        await requestToJoin(deployment, bob)
        await admitMember(deployment, bob, [
            founders[0].governanceSigner,
            founders[1].governanceSigner,
            alice.governanceSigner
        ])

        const bobState = await readMember(deployment, bob)
        printMemberState("Bob", bobState)
        const afterBob = await readSafeState(deployment.safe)
        printSafeState(afterBob)
        check(bobState.approved && bobState.inGroup && bobState.isSafeOwner, "Bob is a member in all three places")
        check(afterBob.threshold === governanceThreshold(afterBob.owners.length), "and the threshold moved again")
        check((await readMember(deployment, alice)).approved, "Alice is still a member after Bob joined")
        await pause()

        step(
            "4",
            "Each member publishes its own meta-stealth address",
            "A member's own auth key writes it, not a quorum, and the same call registers and updates: the\n" +
                "record is one slot it overwrites. Alice publishes and then rotates; Bob publishes his own,\n" +
                "which shows a member's writes reach its record and no other."
        )
        const published = metaStealthAddressFor(ALICE_DEVICE_SECRET)
        await registerMemberIdentity(deployment, alice, published)
        fact("Alice, published", short((await readMember(deployment, alice)).metaStealthAddress))

        const rotated = metaStealthAddressFor(ALICE_ROTATED_SECRET)
        await registerMemberIdentity(deployment, alice, rotated)
        fact("Alice, after rotation", short((await readMember(deployment, alice)).metaStealthAddress))
        check(
            (await readMember(deployment, alice)).metaStealthAddress === rotated,
            "Alice's record holds the address she rotated to, not the one she replaced"
        )

        const bobAddress = metaStealthAddressFor(BOB_DEVICE_SECRET)
        await registerMemberIdentity(deployment, bob, bobAddress)
        fact("Bob, published", short((await readMember(deployment, bob)).metaStealthAddress))
        check(
            (await readMember(deployment, bob)).metaStealthAddress === bobAddress,
            "Bob's record holds exactly what he published"
        )
        check(
            (await readMember(deployment, alice)).metaStealthAddress === rotated,
            "and Alice's record is untouched by his write"
        )
        await pause()

        step(
            "5",
            "A majority removes Bob",
            "Admission in reverse, and just as atomic: record, group leaf, Safe seat and issuer keys all go\n" +
                "together, and the threshold comes back down. Only his networkId is passed, so a removal cannot\n" +
                "be pointed at another member. Its Merkle proof comes from a group rebuilt from chain events,\n" +
                "because Semaphore stores the tree's root and not its leaves."
        )
        await removeMember(deployment, bob, [
            founders[0].governanceSigner,
            founders[1].governanceSigner,
            alice.governanceSigner
        ])

        printMemberState("Bob", await readMember(deployment, bob))
        check(
            (await readMember(deployment, bob)).metaStealthAddress === "0x",
            "the address Bob published in step 4 is gone with his record"
        )
        const afterRemoval = await readSafeState(deployment.safe)
        printSafeState(afterRemoval)
        check(
            afterRemoval.threshold === governanceThreshold(afterRemoval.owners.length),
            "the threshold came back down"
        )
        // A removal zeroes Bob's slot and leaves it in place, so the tree still has two of them. The
        // rebuild replays that, which is why Alice is still found at the index her proof needs.
        const afterBobLeft = await rebuildGroupFromChain(deployment)
        check(afterBobLeft.size === founders.length + 2, "the rebuilt group still has Bob's slot, now zeroed")
        check(
            afterBobLeft.indexOf(alice.identity.commitment) === founders.length,
            "and Alice did not move when Bob was removed"
        )
        await pause()

        step(
            "6",
            "Alice leaves of her own accord",
            "The one operation that skips the Safe, because leaving should not need the consent of the\n" +
                "members being left. Only her own governance signer can call it, so the worst a stolen signer\n" +
                "achieves is ending her own membership."
        )
        await exitNetwork(deployment, alice)

        printMemberState("Alice", await readMember(deployment, alice))
        const final = await readSafeState(deployment.safe)
        printSafeState(final)
        check(final.owners.length === founders.length, "the network is back to its founding members")

        section("Done", "Every operation above was read back from the chain. The local node is now shut down.")
    } finally {
        anvil?.kill()
        endNarration()
    }
}
