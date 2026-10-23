import { UpdateAction } from "@coordination-network/network-member-proof"
import { encodeFunctionData, type Hex } from "viem"
import type { HDAccount } from "viem/accounts"
import { send } from "../shared/config.ts"
import { IDENTITY_REGISTRY_ABI } from "../shared/abis.ts"
import type { Member } from "../shared/personas.ts"
import type { IdentityDeployment } from "../deploy/identity.ts"
import { authoriseUpdate } from "./authorise.ts"

/**
 * Step 3. A member repoints a registered networkId at a new meta-stealth address.
 *
 * Needs its own proof. The one that authorised the registration is spent, and it was bound to the
 * register action and the old address besides, so neither the action nor the payload can be swapped.
 */
export async function updateIdentity(
    deployment: IdentityDeployment,
    member: Member,
    identity: { networkId: Hex; metaStealthAddress: Hex },
    submitter: HDAccount
) {
    const proof = await authoriseUpdate(deployment, member, {
        action: UpdateAction.Update,
        networkId: identity.networkId,
        metaStealthAddress: identity.metaStealthAddress
    })

    return send({
        account: submitter,
        to: deployment.identityRegistry,
        data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: "updateIdentity",
            args: [identity.networkId, identity.metaStealthAddress, proof]
        })
    })
}
