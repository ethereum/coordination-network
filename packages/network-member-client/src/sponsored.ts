import { decodeErrorResult, encodeFunctionData } from "viem"
import type { Hex } from "viem"
import type { Hex32 } from "@coordination-network/credential"
import type { NetworkMemberProof, RegistryLocation } from "@coordination-network/network-member-proof"
import { IDENTITY_REGISTRY_ABI } from "./adapters"
import { RegistryRevertError } from "./errors"
import { SponsoredRelay } from "./sponsored-relay"
import type { SponsoredRelayParams } from "./sponsored-relay"
import type { RegistrationWrite, RegistrationWriter } from "./types"

export type { SponsoredMemberKeys } from "./sponsored-relay"

export interface SponsoredIdentityRegistryWriterParams extends SponsoredRelayParams {
    registry: RegistryLocation
}

/**
 * Sponsored RegistrationWriter: relays a `registerIdentity` call through {@link SponsoredRelay},
 * so the member pays nothing and no sender links two of the member's relayed registrations to
 * each other.
 */
export class SponsoredIdentityRegistryWriter implements RegistrationWriter {
    readonly registry: RegistryLocation
    private readonly relay: SponsoredRelay

    constructor({ registry, ...relayParams }: SponsoredIdentityRegistryWriterParams) {
        this.registry = registry
        this.relay = new SponsoredRelay(relayParams)
    }

    async registerIdentity(
        networkId: Hex32,
        metaStealthAddress: Hex,
        proof: NetworkMemberProof
    ): Promise<RegistrationWrite> {
        const { receipt, sponsorship } = await this.relay.relay({
            target: this.registry.address,
            data: encodeFunctionData({
                abi: IDENTITY_REGISTRY_ABI,
                functionName: "registerIdentity",
                args: [networkId, metaStealthAddress, proof]
            })
        })

        if (!receipt.success) {
            if (receipt.revertReason !== undefined && decodedErrorName(receipt.revertReason) === "AlreadyRegistered") {
                throw new RegistryRevertError("AlreadyRegistered", receipt.revertReason)
            }
            throw new Error("sponsored registerIdentity user operation reverted")
        }

        return { txHash: receipt.transactionHash, sponsorship }
    }
}

/** The IdentityRegistry error name `revertReason` decodes to, or undefined for anything else (a different error, or no revert data at all). */
function decodedErrorName(revertReason: Hex): string | undefined {
    try {
        return decodeErrorResult({ abi: IDENTITY_REGISTRY_ABI, data: revertReason }).errorName
    } catch {
        return undefined
    }
}
