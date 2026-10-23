import type { NetworkMemberProof } from "@coordination-network/network-member-proof"
import { encodeFunctionData, type Hex } from "viem"
import type { HDAccount } from "viem/accounts"
import { IDENTITY_REGISTRY_ABI } from "../shared/abis.ts"
import { send } from "../shared/config.ts"
import type { IdentityDeployment } from "../deploy/identity.ts"

/**
 * Submits an identity registry write with a proof made earlier.
 *
 * The flows elsewhere build a proof and send it in one call, which is what a member server does. This
 * separates the two halves, because the combined demo needs to hold a proof across a governance change
 * and see whether the registry still takes it afterwards.
 */
export async function submitRegister(
    deployment: IdentityDeployment,
    identity: { networkId: Hex; metaStealthAddress: Hex },
    proof: NetworkMemberProof,
    submitter: HDAccount
) {
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

/** The same, for an update. */
export async function submitUpdate(
    deployment: IdentityDeployment,
    identity: { networkId: Hex; metaStealthAddress: Hex },
    proof: NetworkMemberProof,
    submitter: HDAccount
) {
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
