import type { Address } from "viem"
import { deploy } from "../shared/artifacts.ts"
import { deployNetworkMemberStack, type NetworkMemberDeployment } from "./network-member.ts"

/** The identity registry, alongside the member stack whose group authorises its writes. */
export interface IdentityDeployment extends NetworkMemberDeployment {
    /** Resolves a user's networkId to a meta-stealth address. */
    identityRegistry: Address
}

/**
 * Deploys the identity registry against the approved-member group.
 *
 * It is pointed at the group rather than owning it, which is the whole arrangement: the registry
 * checks membership proofs against a group governance maintains elsewhere, and stores nothing about
 * members itself, only a networkId and the address it resolves to. Nothing here is `onlyOwner`,
 * because no write has an owner to check.
 */
export async function deployIdentityStack(members?: NetworkMemberDeployment): Promise<IdentityDeployment> {
    const deployed = members ?? (await deployNetworkMemberStack())

    const identityRegistry = await deploy("IdentityRegistry", [deployed.semaphore, deployed.groupId])

    return { ...deployed, identityRegistry }
}
