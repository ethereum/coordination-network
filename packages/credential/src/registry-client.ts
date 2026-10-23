import { createPublicClient, http, PublicClient } from "viem"
import { Hex32 } from "./types"

const REGISTRY_ABI = [
    {
        type: "function",
        name: "isApproved",
        stateMutability: "view",
        inputs: [{ name: "memberNetworkId", type: "bytes32" }],
        outputs: [{ type: "bool" }]
    }
] as const

/**
 * Chain-backed read of NetworkMemberRegistry.isApproved (spec, network member
 * registry). Satisfies the approval half of Resolver so it can back the
 * issuance and verification governance gates once a registry is deployed.
 */
export class NetworkMemberRegistryClient {
    private readonly client: PublicClient

    constructor(
        private readonly registryAddress: `0x${string}`,
        rpcUrl: string
    ) {
        this.client = createPublicClient({ transport: http(rpcUrl) })
    }

    async isApprovedNetworkMember(id: Hex32): Promise<boolean> {
        return this.client.readContract({
            address: this.registryAddress,
            abi: REGISTRY_ABI,
            functionName: "isApproved",
            args: [id]
        })
    }
}
