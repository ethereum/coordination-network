import type { ChildProcess } from "node:child_process"
import { UpdateAction } from "@coordination-network/network-member-proof"
import { governanceThreshold } from "@coordination-network/network-member-governance"
import { SEMAPHORE_ABI } from "../shared/abis.ts"
import { advanceTime, startAnvil } from "../shared/chain.ts"
import { publicClient, roles, RPC_URL } from "../shared/config.ts"
import { deployIdentityStack } from "../deploy/identity.ts"
import {
    check,
    checkRejected,
    endNarration,
    fact,
    pause,
    printSafeState,
    section,
    short,
    step
} from "../shared/narrate.ts"
import { alice, dana, erin, founders, metaStealthAddressFor } from "../shared/personas.ts"
import { readSafeState } from "../shared/safe.ts"
import { releaseProver } from "../shared/snark.ts"
import { requestToJoin } from "../network-member/1-request-to-join.ts"
import { admitMember } from "../network-member/2-admit-member.ts"
import { printMemberState, readMember } from "../network-member/3-read-member.ts"
import { registerMemberIdentity } from "../network-member/4-register-member-identity.ts"
import { removeMember } from "../network-member/5-remove-member.ts"
import { authoriseUpdate } from "../identity/authorise.ts"
import { registerIdentity } from "../identity/1-register-identity.ts"
import { readIdentity } from "../identity/2-read-identity.ts"
import { updateIdentity } from "../identity/3-update-identity.ts"
import { removeIdentity } from "../identity/4-remove-identity.ts"
import { submitRegister, submitUpdate } from "./deferred-write.ts"

const ALICE_DEVICE_SECRET = `0x${"0a".repeat(32)}` as const

/**
 * Both registries together, and what connects them.
 *
 * Each registry has its own walkthrough, and this does not repeat them. What it shows is what neither
 * can alone: that being admitted to the member registry is what gives a member the authority to write
 * to the identity registry, and that losing membership takes that authority away, though not at the
 * instant governance votes.
 *
 * The gap is Semaphore's recent-root window. A proof is checked against a group root, and a root stays
 * acceptable for the group's tree duration after it is replaced, so a proof made shortly before a
 * removal keeps working for a while after it. That is deliberate, because it stops every write in
 * flight breaking each time governance admits somebody, and it is why the runbook says to treat a
 * removal as effective an hour after it rather than immediately.
 */
export async function runMemberAndIdentityWalkthrough() {
    let anvil: ChildProcess | undefined

    try {
        section(
            "Both registries",
            `Starting Anvil on ${RPC_URL}, deploying the governance stack with its founding members,\n` +
                "and an identity registry pointed at the approved-member group."
        )
        anvil = await startAnvil()

        const deployment = await deployIdentityStack()
        const rootWindow = await publicClient.readContract({
            address: deployment.semaphore,
            abi: SEMAPHORE_ABI,
            functionName: "groups",
            args: [deployment.groupId]
        })

        fact("member registry", short(deployment.registry))
        fact("identity registry", short(deployment.identityRegistry))
        fact("recent-root window", `${rootWindow / 60n} minutes`)
        await pause()

        step(
            "1",
            "An organisation joins the network",
            "The member registry half: Alice asks to join, and a majority of the founding members admits\n" +
                "her record, her group leaf and her seat at the Safe in one call."
        )
        await requestToJoin(deployment, alice)
        await admitMember(deployment, alice, [founders[0].governanceSigner, founders[1].governanceSigner])

        printMemberState("Alice", await readMember(deployment, alice))
        printSafeState(await readSafeState(deployment.safe))
        await pause()

        step(
            "2",
            "And can immediately act in the identity registry",
            "Her leaf in the approved-member group is what lets her write here, and it is the only thing\n" +
                "the two registries share: the identity registry knows the group, and never the member\n" +
                "records behind it."
        )
        await registerIdentity(deployment, alice, dana, roles.submitter)

        fact("Dana resolves to", short((await readIdentity(deployment, dana.networkId))!))
        check(
            (await readIdentity(deployment, dana.networkId)) === dana.metaStealthAddress,
            "the user Alice registered resolves to the address she registered"
        )
        await pause()

        step(
            "3",
            "Both registries take an update",
            "Alice publishes her own meta-stealth address with her auth key, which is the member\n" +
                "registry's update. Dana replaces her device, so Alice repoints her entry with a fresh proof,\n" +
                "which is the identity registry's. Different keys, different authorisation, same member."
        )
        const aliceAddress = metaStealthAddressFor(ALICE_DEVICE_SECRET)
        await registerMemberIdentity(deployment, alice, aliceAddress)
        await updateIdentity(
            deployment,
            alice,
            { networkId: dana.networkId, metaStealthAddress: dana.rotatedMetaStealthAddress },
            roles.submitter
        )

        fact("Alice's own address", short((await readMember(deployment, alice)).metaStealthAddress))
        fact("Dana resolves to", short((await readIdentity(deployment, dana.networkId))!))
        check(
            (await readMember(deployment, alice)).metaStealthAddress === aliceAddress &&
                (await readIdentity(deployment, dana.networkId)) === dana.rotatedMetaStealthAddress,
            "both registries hold the new addresses"
        )
        await pause()

        step(
            "4",
            "Alice prepares two writes, and is then removed",
            "While she is still a member she builds two proofs and submits neither: one to register Erin,\n" +
                "and one to point Dana back at the address she had before step 3. Governance then removes\n" +
                "her: record, group leaf, Safe seat and issuer keys all go, and the group root moves."
        )
        const registerErin = await authoriseUpdate(deployment, alice, {
            action: UpdateAction.Register,
            networkId: erin.networkId,
            metaStealthAddress: erin.metaStealthAddress
        })
        const repointDana = await authoriseUpdate(deployment, alice, {
            action: UpdateAction.Update,
            networkId: dana.networkId,
            metaStealthAddress: dana.metaStealthAddress
        })

        fact("proof she holds", "register Erin")
        fact("proof she holds", "point Dana back")

        await removeMember(
            deployment,
            alice,
            founders.map((founder) => founder.governanceSigner)
        )

        printMemberState("Alice", await readMember(deployment, alice))
        check(!(await readMember(deployment, alice)).approved, "Alice is no longer a member")
        check(
            (await readIdentity(deployment, dana.networkId)) === dana.rotatedMetaStealthAddress,
            "and Dana's entry is unaffected: the registry never recorded who registered her"
        )
        await pause()

        step(
            "5",
            "Her authority ends on the window, not on the vote",
            "Her proof registering Erin still lands, because Semaphore accepts the root that was current\n" +
                "when a proof was made until that root's window closes. Governance has to treat a removal as\n" +
                "effective at the end of the window, not at the transaction that made it.\n" +
                "Her proof pointing Dana back is then refused, once the clock is past that window, and she\n" +
                "cannot build a new one because her leaf is gone from the group she would prove against."
        )
        await submitRegister(deployment, erin, registerErin, roles.submitter)

        fact("Erin resolves to", short((await readIdentity(deployment, erin.networkId))!))
        check(
            (await readIdentity(deployment, erin.networkId)) === erin.metaStealthAddress,
            "Erin is registered, by a proof Alice made before she was removed"
        )

        await advanceTime(rootWindow + 60n)
        fact("clock advanced by", `${rootWindow / 60n + 1n} minutes`)

        await checkRejected(
            submitUpdate(
                deployment,
                { networkId: dana.networkId, metaStealthAddress: dana.metaStealthAddress },
                repointDana,
                roles.submitter
            ),
            "Semaphore__MerkleTreeRootIsExpired()",
            "her other proof, pointing Dana back, is refused once the window has closed"
        )
        check(
            (await readIdentity(deployment, dana.networkId)) === dana.rotatedMetaStealthAddress,
            "so Dana still resolves to the address from step 3"
        )

        // The other half of why the removal is now effective, and the half no contract can show: she
        // cannot replace the expired proof, because building one needs her leaf in the current group.
        let couldStillProve = true
        try {
            await authoriseUpdate(deployment, alice, {
                action: UpdateAction.Update,
                networkId: dana.networkId,
                metaStealthAddress: dana.metaStealthAddress
            })
        } catch {
            couldStillProve = false
        }
        check(!couldStillProve, "and she cannot build a replacement, having no leaf left to prove against")
        await pause()

        step(
            "6",
            "The network carries on without her",
            "A founding member clears both entries with proofs of its own. Nothing Alice registered was\n" +
                "tied to her, so her departure costs the network the authority she held and nothing else."
        )
        await removeIdentity(deployment, founders[0], dana.networkId, roles.submitter)
        await removeIdentity(deployment, founders[0], erin.networkId, roles.submitter)

        check(
            (await readIdentity(deployment, dana.networkId)) === null &&
                (await readIdentity(deployment, erin.networkId)) === null,
            "both entries are gone, cleared by a member who never registered them"
        )
        const final = await readSafeState(deployment.safe)
        printSafeState(final)
        check(final.threshold === governanceThreshold(final.owners.length), "and the governance rule still holds")

        section("Done", "Every operation above was read back from the chain. The local node is now shut down.")
    } finally {
        anvil?.kill()
        await releaseProver()
        endNarration()
    }
}
