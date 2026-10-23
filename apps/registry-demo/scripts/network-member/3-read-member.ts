import type { Address, Hex } from "viem"
import { MEMBER_REGISTRY_ABI, NETWORK_MEMBER_GROUP_ABI, SAFE_ABI } from "../shared/abis.ts"
import { publicClient } from "../shared/config.ts"
import { fact, short } from "../shared/narrate.ts"
import type { NetworkMemberDeployment } from "../deploy/network-member.ts"
import type { Member } from "../shared/personas.ts"

/** Everything the chain says about one member. Reads are public, so this is what anyone can see. */
export interface MemberState {
    /** Whether the registry holds a record. */
    approved: boolean
    /** The meta-stealth address the member published, `0x` when it has published none. */
    metaStealthAddress: Hex
    /** The Semaphore commitment on the record, zero when there is none. */
    semaphoreCommitment: bigint
    /** The governance signer on the record, zero when there is none. */
    governanceSigner: Address
    /** Whether the commitment is currently a leaf in the approved-member group. */
    inGroup: boolean
    /** Whether the governance signer currently holds a seat at the Safe. */
    isSafeOwner: boolean
}

/**
 * Step 3. Reads a member's state back from all three contracts. They should be present together or
 * absent together, and every governance operation here is verified against all three.
 */
export async function readMember(deployment: NetworkMemberDeployment, member: Member): Promise<MemberState> {
    const registry = { address: deployment.registry, abi: MEMBER_REGISTRY_ABI } as const

    const [approved, metaStealthAddress, semaphoreCommitment, governanceSigner] = await Promise.all([
        publicClient.readContract({ ...registry, functionName: "isApproved", args: [member.networkId] }),
        publicClient.readContract({ ...registry, functionName: "identity", args: [member.networkId] }),
        publicClient.readContract({ ...registry, functionName: "semaphoreCommitmentOf", args: [member.networkId] }),
        publicClient.readContract({ ...registry, functionName: "governanceSignerOf", args: [member.networkId] })
    ])

    const [inGroup, isSafeOwner] = await Promise.all([
        publicClient.readContract({
            address: deployment.group,
            abi: NETWORK_MEMBER_GROUP_ABI,
            functionName: "hasNetworkMember",
            args: [member.identity.commitment]
        }),
        publicClient.readContract({
            address: deployment.safe,
            abi: SAFE_ABI,
            functionName: "isOwner",
            args: [member.governanceSigner.address]
        })
    ])

    return {
        approved,
        metaStealthAddress,
        semaphoreCommitment,
        governanceSigner,
        inGroup,
        isSafeOwner
    }
}

/** Prints a member's state. Lives here, not in the shared narration, because it knows this registry. */
export function printMemberState(name: string, state: MemberState) {
    fact(`${name} approved`, String(state.approved))
    fact(
        `${name} meta-stealth address`,
        state.metaStealthAddress === "0x" ? "none published" : short(state.metaStealthAddress)
    )
    fact(`${name} in the group`, String(state.inGroup))
    fact(`${name} holds a Safe seat`, String(state.isSafeOwner))
}

/** Whether the orchestrator can act through the Safe, which admission and removal both need. */
export async function isModuleEnabled(deployment: NetworkMemberDeployment): Promise<boolean> {
    return publicClient.readContract({
        address: deployment.safe,
        abi: SAFE_ABI,
        functionName: "isModuleEnabled",
        args: [deployment.governance]
    })
}

/** Whether the registry can retire a removed member's signing keys, which admission refuses without. */
export async function issuerSetIsWired(deployment: NetworkMemberDeployment): Promise<boolean> {
    const wired = await publicClient.readContract({
        address: deployment.registry,
        abi: MEMBER_REGISTRY_ABI,
        functionName: "approvedIssuerSet"
    })

    return wired.toLowerCase() === deployment.issuerSet.toLowerCase()
}
