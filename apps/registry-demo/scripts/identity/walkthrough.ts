import type { ChildProcess } from "node:child_process"
import { memberAccountKey } from "@coordination-network/network-member-governance"
import { startAnvil } from "../shared/chain.ts"
import { roles, RPC_URL } from "../shared/config.ts"
import { deployIdentityStack } from "../deploy/identity.ts"
import { check, endNarration, fact, pause, section, short, step } from "../shared/narrate.ts"
import { alice, dana, erin, founders } from "../shared/personas.ts"
import { rebuildGroupFromChain } from "../shared/semaphore-group.ts"
import { releaseProver } from "../shared/snark.ts"
import { MEMBER_REGISTRY_ABI, SAFE_ABI } from "../shared/abis.ts"
import { publicClient } from "../shared/config.ts"
import { requestToJoin } from "../network-member/1-request-to-join.ts"
import { admitMember } from "../network-member/2-admit-member.ts"
import { readMember } from "../network-member/3-read-member.ts"
import { registerIdentity } from "./1-register-identity.ts"
import { readIdentity } from "./2-read-identity.ts"
import { updateIdentity } from "./3-update-identity.ts"
import { removeIdentity } from "./4-remove-identity.ts"

/**
 * The identity registry, walked through from a network with approved members to a user registered,
 * resolved, repointed and cleared.
 *
 * Its authorisation model is the opposite of the member registry's. There every write is gated on
 * `msg.sender`; here no write path reads the sender at all. What authorises a write is a Semaphore
 * membership proof against the approved-member group, so the chain learns that some approved member
 * made the change and never which one.
 *
 * Narrated and checked as it goes, so running it is the assertion. The contracts' own rules are
 * covered by `packages/contracts/test` and the proof construction by `packages/network-member-proof`;
 * what this exercises is those proofs, generated in TypeScript, being accepted by the real registry
 * against a group rebuilt from the chain.
 */
export async function runIdentityWalkthrough() {
    let anvil: ChildProcess | undefined

    try {
        section(
            "A network with an identity registry",
            `Starting Anvil on ${RPC_URL}, deploying the governance stack with its founding members,\n` +
                "and pointing an identity registry at the approved-member group."
        )
        anvil = await startAnvil()

        const deployment = await deployIdentityStack()

        fact("identity registry", short(deployment.identityRegistry))
        fact("approved-member group", `${deployment.groupId} on ${short(deployment.semaphore)}`)

        // Alice joins so the walkthrough acts as a member admitted the ordinary way rather than one
        // written in at genesis.
        await requestToJoin(deployment, alice)
        await admitMember(deployment, alice, [founders[0].governanceSigner, founders[1].governanceSigner])

        check((await readMember(deployment, alice)).inGroup, "Alice is an approved member, so she can authorise writes")
        check((await readIdentity(deployment, dana.networkId)) === null, "and the registry resolves nobody yet")
        await pause()

        step(
            "1",
            "Alice registers Dana's identity",
            "Alice authorises the write with a membership proof against the approved-member group, bound\n" +
                "to this exact action, networkId and address. The transaction is then sent by an account with\n" +
                "no part in the network at all: no write path here reads the sender, so the proof is the\n" +
                "authority and the submitter is not."
        )
        fact("Dana's networkId", short(dana.networkId))
        fact("submitted by", short(roles.submitter.address))

        await registerIdentity(deployment, alice, dana, roles.submitter)

        fact("registry resolves to", short((await readIdentity(deployment, dana.networkId))!))
        check(
            (await readIdentity(deployment, dana.networkId)) === dana.metaStealthAddress,
            "Dana's networkId resolves to the address Alice registered"
        )

        // The claim is that the sender is nobody, so check both halves of it: no seat at the Safe, and
        // no record in the member registry under the networkId its key would derive.
        const [submitterIsOwner, submitterIsApproved] = await Promise.all([
            publicClient.readContract({
                address: deployment.safe,
                abi: SAFE_ABI,
                functionName: "isOwner",
                args: [roles.submitter.address]
            }),
            publicClient.readContract({
                address: deployment.registry,
                abi: MEMBER_REGISTRY_ABI,
                functionName: "isApproved",
                args: [memberAccountKey(roles.submitter.publicKey).memberNetworkId]
            })
        ])
        check(
            !submitterIsOwner && !submitterIsApproved,
            "and the account that sent it is neither an approved member nor an approver"
        )
        check(
            (await rebuildGroupFromChain(deployment)).size === founders.length + 1,
            "the group is unchanged by the write: this registry reads membership and never writes it"
        )
        await pause()

        step(
            "2",
            "Anyone can resolve it",
            "Reads are public and ungated, which is what lets a sender route value to Dana without asking\n" +
                "her for anything. A networkId nobody has registered resolves to nothing rather than failing."
        )
        fact("Dana", short((await readIdentity(deployment, dana.networkId))!))
        fact("Erin", String(await readIdentity(deployment, erin.networkId)))
        check((await readIdentity(deployment, erin.networkId)) === null, "an unregistered networkId resolves to null")
        await pause()

        step(
            "3",
            "Dana replaces her device, and Alice repoints her entry",
            "A second proof, bound to the update action and the new address. The proof that authorised the\n" +
                "registration cannot do this: Semaphore burns its nullifier on the way in, and it was bound to\n" +
                "a different action and a different address besides."
        )
        await updateIdentity(
            deployment,
            alice,
            { networkId: dana.networkId, metaStealthAddress: dana.rotatedMetaStealthAddress },
            roles.submitter
        )

        fact("registry resolves to", short((await readIdentity(deployment, dana.networkId))!))
        check(
            (await readIdentity(deployment, dana.networkId)) === dana.rotatedMetaStealthAddress,
            "Dana's networkId now resolves to her new address"
        )
        await pause()

        step(
            "4",
            "And clears it",
            "A third proof, carrying no address because a removal writes none. The entry goes back to\n" +
                "resolving nothing, and the networkId is free to be registered again later."
        )
        await removeIdentity(deployment, alice, dana.networkId, roles.submitter)

        fact("registry resolves to", String(await readIdentity(deployment, dana.networkId)))
        check((await readIdentity(deployment, dana.networkId)) === null, "Dana's entry is gone")
        check(
            (await readMember(deployment, alice)).approved,
            "and Alice is still a member: writing here changes nothing in the member registry"
        )

        section("Done", "Every operation above was read back from the chain. The local node is now shut down.")
    } finally {
        anvil?.kill()
        await releaseProver()
        endNarration()
    }
}
