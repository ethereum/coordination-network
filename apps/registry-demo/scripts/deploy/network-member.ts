import { encodeFunctionData, type Address } from "viem"
import { MEMBER_REGISTRY_ABI, NETWORK_MEMBER_GROUP_ABI, SAFE_ABI } from "../shared/abis.ts"
import { deploy } from "../shared/artifacts.ts"
import { publicClient } from "../shared/config.ts"
import { founders } from "../shared/personas.ts"
import { approveAndExecute, buildSafeCall } from "../shared/safe.ts"
import { deployBase, foundingQuorum, type BaseDeployment } from "./base.ts"

/** The network member registry and everything that governs it. */
export interface NetworkMemberDeployment extends BaseDeployment {
    /** Who is approved, and each member's keys. */
    registry: Address
    /** The contract administering the approved-member Semaphore group. */
    group: Address
    /** The orchestrator, enabled as a Safe module. */
    governance: Address
    /** Members' credential signing keys, retired when a member is removed. */
    issuerSet: Address
    /** The approved-member group's id on the Semaphore deployment. */
    groupId: bigint
}

/**
 * Deploys the network member stack and completes the runbook's phase 0, leaving a founding network:
 * the Safe owning the registry and the group, the orchestrator enabled as a module, and the founding
 * members holding records, group leaves and seats.
 *
 * Three Safe transactions follow the deployment, under a quorum, and none is optional. The issuer set
 * has to be wired first, because `approveNetworkMember` reverts `IssuerSetNotWired` without it; the
 * module has to be enabled, because the orchestrator cannot otherwise reach the Safe's own owner set;
 * and genesis then admits the founders.
 */
export async function deployNetworkMemberStack(base?: BaseDeployment): Promise<NetworkMemberDeployment> {
    const deployed = base ?? (await deployBase())

    const registry = await deploy("NetworkMemberRegistry", [deployed.safe])
    const group = await deploy("NetworkMemberGroup", [deployed.semaphore, deployed.safe])
    const governance = await deploy("NetworkMemberGovernance", [deployed.safe, registry, group])

    // The set takes the registry's address, so it cannot be a constructor argument of the registry.
    const issuerSet = await deploy("ApprovedIssuerSet", [registry])

    const quorum = foundingQuorum()

    await approveAndExecute(
        deployed.context,
        await buildSafeCall(deployed.context, {
            to: registry,
            value: "0",
            data: encodeFunctionData({
                abi: MEMBER_REGISTRY_ABI,
                functionName: "setApprovedIssuerSet",
                args: [issuerSet]
            })
        }),
        quorum
    )

    await approveAndExecute(
        deployed.context,
        await buildSafeCall(deployed.context, {
            to: deployed.safe,
            value: "0",
            data: encodeFunctionData({ abi: SAFE_ABI, functionName: "enableModule", args: [governance] })
        }),
        quorum
    )

    // Runbook phase 0, step 6: the founding members' own records and group leaves, in one genesis
    // transaction. These go straight to the registry and the group rather than through the
    // orchestrator, because their governance signers are already owners and `admitMember` would try to
    // add each of them to the Safe a second time.
    await approveAndExecute(
        deployed.context,
        await buildSafeCall(
            deployed.context,
            founders.flatMap((founder) => [
                {
                    to: registry,
                    value: "0",
                    data: encodeFunctionData({
                        abi: MEMBER_REGISTRY_ABI,
                        functionName: "approveNetworkMember",
                        args: [
                            founder.accountKeyX,
                            founder.accountKeyY,
                            founder.identity.commitment,
                            founder.governanceSigner.address
                        ]
                    })
                },
                {
                    to: group,
                    value: "0",
                    data: encodeFunctionData({
                        abi: NETWORK_MEMBER_GROUP_ABI,
                        functionName: "addNetworkMember",
                        args: [founder.identity.commitment]
                    })
                }
            ])
        ),
        quorum
    )

    const groupId = await publicClient.readContract({
        address: group,
        abi: NETWORK_MEMBER_GROUP_ABI,
        functionName: "GROUP_ID"
    })

    return { ...deployed, registry, group, governance, issuerSet, groupId }
}
