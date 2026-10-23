import { UpdateAction } from "@coordination-network/network-member-proof"
import { encodeFunctionData, type Hex } from "viem"
import type { HDAccount } from "viem/accounts"
import { send } from "../shared/config.ts"
import { IDENTITY_REGISTRY_ABI } from "../shared/abis.ts"
import type { Member } from "../shared/personas.ts"
import type { IdentityDeployment } from "../deploy/identity.ts"
import { authoriseUpdate } from "./authorise.ts"

/**
 * Step 4. A member clears a networkId's entry.
 *
 * The proof carries no meta-stealth address, because a removal writes none: its message covers the
 * remove action and the networkId alone.
 */
export async function removeIdentity(
    deployment: IdentityDeployment,
    member: Member,
    networkId: Hex,
    submitter: HDAccount
) {
    const proof = await authoriseUpdate(deployment, member, { action: UpdateAction.Remove, networkId })

    return send({
        account: submitter,
        to: deployment.identityRegistry,
        data: encodeFunctionData({
            abi: IDENTITY_REGISTRY_ABI,
            functionName: "removeIdentity",
            args: [networkId, proof]
        })
    })
}
