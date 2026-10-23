import assert from "node:assert/strict"
import { Identity } from "@coordination-network/account"
import { type Hex32, Resolver, RevocationWriter } from "@coordination-network/credential"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { RevocationDeployment, submitRevocation } from "./deployer"

export function createRevocationResolver(
    deployment: RevocationDeployment,
    memberIdentity: Identity,
    issuerNetworkId: Hex32,
    registry: RevocationRegistry
): Resolver & RevocationWriter {
    return {
        async isApprovedNetworkMember(id) {
            return id === issuerNetworkId
        },
        async getCredentialPublicKey() {
            return null
        },
        async isRevoked(commitment) {
            return deployment.chain.publicClient.readContract({
                address: deployment.revocationAddress,
                abi: deployment.revocationAbi,
                functionName: "isRevoked",
                args: [deployment.registryId, commitment]
            }) as Promise<boolean>
        },
        async revoke(commitment) {
            const lowLeafIndex = BigInt(registry.lowLeafIndexOf(commitment))
            await submitRevocation(deployment, memberIdentity, commitment, lowLeafIndex)
            registry.revoke(commitment)

            const root = await deployment.chain.publicClient.readContract({
                address: deployment.revocationAddress,
                abi: deployment.revocationAbi,
                functionName: "getRevocationRoot",
                args: [deployment.registryId]
            })
            assert.equal(root, registry.root, "local and on-chain revocation roots differ")
        }
    }
}
