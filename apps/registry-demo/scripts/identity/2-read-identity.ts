import { IdentityRegistryClient } from "@coordination-network/network-member-client"
import type { Hex } from "viem"
import { publicClient } from "../shared/config.ts"
import type { IdentityDeployment } from "../deploy/identity.ts"

/**
 * Step 2. Resolves a networkId to the meta-stealth address the registry holds for it.
 *
 * Reads are public and ungated: anyone can resolve any networkId, which is what lets a sender route
 * value without asking the recipient for anything. Uses the client a member server would use rather than
 * a hand-rolled call, and returns null when nothing is registered.
 */
export async function readIdentity(deployment: IdentityDeployment, networkId: Hex): Promise<Hex | null> {
    const registry = new IdentityRegistryClient(deployment.identityRegistry, publicClient)

    return registry.getIdentity(networkId)
}
