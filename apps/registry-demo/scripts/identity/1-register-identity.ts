import { UpdateAction } from "@coordination-network/network-member-proof"
import { encodeFunctionData, type Hex } from "viem"
import type { HDAccount } from "viem/accounts"
import { send } from "../shared/config.ts"
import { IDENTITY_REGISTRY_ABI } from "../shared/abis.ts"
import type { Member } from "../shared/personas.ts"
import type { IdentityDeployment } from "../deploy/identity.ts"
import { authoriseUpdate } from "./authorise.ts"

/**
 * Step 1. An approved member registers a user's identity.
 *
 * The member authorises the write with a membership proof; the transaction is then sent by whichever
 * account is holding the gas. No write path in this registry reads `msg.sender`, so the sender is not
 * the authority and does not have to be the member. That is what lets a member submit from a fresh
 * address with a paymaster paying, leaving nothing on chain that links the write back to it.
 *
 * @param submitter The account paying for the transaction. Deliberately not the member's.
 */
export async function registerIdentity(
    deployment: IdentityDeployment,
    member: Member,
    identity: { networkId: Hex; metaStealthAddress: Hex },
    submitter: HDAccount
) {
    const proof = await authoriseUpdate(deployment, member, {
        action: UpdateAction.Register,
        networkId: identity.networkId,
        metaStealthAddress: identity.metaStealthAddress
    })

    return send({
        account: submitter,
        to: deployment.identityRegistry,
        data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: "registerIdentity",
            args: [identity.networkId, identity.metaStealthAddress, proof]
        })
    })
}
