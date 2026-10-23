import type { Hex } from "@coordination-network/identity"
import { encodeFunctionData } from "viem"
import { MEMBER_REGISTRY_ABI } from "../shared/abis.ts"
import { send } from "../shared/config.ts"
import type { NetworkMemberDeployment } from "../deploy/network-member.ts"
import type { Member } from "../shared/personas.ts"

/**
 * Step 4. The member publishes, or repoints, its own meta-stealth address.
 *
 * Gated on the auth address rather than on governance, so a member rotates without asking a quorum;
 * governance can also write it, which is the recovery path for a lost auth key. The same call
 * registers and updates, because the record is one slot the member overwrites.
 *
 * This is the members' own resolution path. Users resolve through the `IdentityRegistry`, a different
 * contract with a different authorisation model.
 */
export async function registerMemberIdentity(
    deployment: NetworkMemberDeployment,
    member: Member,
    metaStealthAddress: Hex
) {
    return send({
        account: member.auth,
        to: deployment.registry,
        data: encodeFunctionData({
            abi: MEMBER_REGISTRY_ABI,
            functionName: "registerNetworkMemberIdentity",
            args: [member.networkId, metaStealthAddress]
        })
    })
}
