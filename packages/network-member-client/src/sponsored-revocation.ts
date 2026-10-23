import { decodeErrorResult, encodeFunctionData } from "viem"
import type { Account, Chain, Hex, Transport, WalletClient } from "viem"
import type { NetworkMemberProof, RegistryLocation } from "@coordination-network/network-member-proof"
import { revertErrorName } from "./adapters"
import { RevocationRevertError } from "./errors"
import { SponsoredRelay } from "./sponsored-relay"
import type { RevocationRegistryWriter, RevocationWrite } from "./types"

/**
 * The `CredentialRevocationRegistry` fragments a writer needs. The errors matter as much as the
 * function: `InvalidLowLeaf` is the one a caller recomputes an index and retries on, and
 * `LeafAlreadyExists` the one it stops on, so both writers must decode the same names.
 */
export const CREDENTIAL_REVOCATION_REGISTRY_ABI = [
    {
        type: "function",
        name: "revoke",
        stateMutability: "nonpayable",
        inputs: [
            { name: "revocationCommitment", type: "uint256" },
            { name: "lowLeafIndex", type: "uint256" },
            {
                name: "proof",
                type: "tuple",
                components: [
                    { name: "merkleTreeDepth", type: "uint256" },
                    { name: "merkleTreeRoot", type: "uint256" },
                    { name: "nullifier", type: "uint256" },
                    { name: "scope", type: "uint256" },
                    { name: "points", type: "uint256[8]" }
                ]
            }
        ],
        outputs: []
    },
    { type: "error", name: "InvalidLowLeaf", inputs: [] },
    { type: "error", name: "LeafAlreadyExists", inputs: [] },
    { type: "error", name: "LeafCannotBeZero", inputs: [] },
    { type: "error", name: "LeafGreaterThanSnarkScalarField", inputs: [] },
    { type: "error", name: "RegistryDoesNotExist", inputs: [] },
    { type: "error", name: "CallerIsNotTheRegistryAdmin", inputs: [] },
    { type: "error", name: "Semaphore__GroupHasNoMembers", inputs: [] },
    { type: "error", name: "Semaphore__MerkleTreeDepthIsNotSupported", inputs: [] },
    { type: "error", name: "Semaphore__MerkleTreeRootIsExpired", inputs: [] },
    { type: "error", name: "Semaphore__MerkleTreeRootIsNotPartOfTheGroup", inputs: [] },
    { type: "error", name: "Semaphore__YouAreUsingTheSameNullifierTwice", inputs: [] },
    { type: "error", name: "Semaphore__InvalidProof", inputs: [] }
] as const

/**
 * Sponsored RevocationRegistryWriter: relays a `revoke` call through {@link SponsoredRelay}, so
 * the write costs the member nothing and its sender names no member. That matters more here than for
 * registration: one tree holds the whole network's revocations, and an EOA paying for the write
 * would say which member revoked which credential.
 */
export class SponsoredRevocationWriter implements RevocationRegistryWriter {
    constructor(
        readonly registry: RegistryLocation,
        private readonly relay: SponsoredRelay
    ) {}

    async revoke(commitment: bigint, lowLeafIndex: bigint, proof: NetworkMemberProof): Promise<RevocationWrite> {
        const { receipt, sponsorship } = await this.relay.relay({
            target: this.registry.address,
            data: encodeFunctionData({
                abi: CREDENTIAL_REVOCATION_REGISTRY_ABI,
                functionName: "revoke",
                args: [commitment, lowLeafIndex, proof]
            })
        })

        if (!receipt.success) {
            throw new RevocationRevertError(decodedRevertReason(receipt.revertReason), receipt.revertReason)
        }

        return { txHash: receipt.transactionHash, sponsorship }
    }
}

/**
 * Chain-backed RevocationRegistryWriter over `CredentialRevocationRegistry.revoke`, for a member
 * server running without an account-abstraction stack. The submitting EOA is on chain, so it says
 * which member revoked; the sponsored writer above is what keeps that unattributable.
 *
 * No receipt wait: a reverting write surfaces at viem's gas estimate, and a returned txHash means
 * submitted, matching `IdentityRegistryWriter`.
 */
export class DirectRevocationWriter implements RevocationRegistryWriter {
    constructor(
        readonly registry: RegistryLocation,
        private readonly walletClient: Pick<WalletClient<Transport, Chain, Account>, "writeContract">
    ) {}

    async revoke(commitment: bigint, lowLeafIndex: bigint, proof: NetworkMemberProof): Promise<RevocationWrite> {
        try {
            const txHash = await this.walletClient.writeContract({
                address: this.registry.address,
                abi: CREDENTIAL_REVOCATION_REGISTRY_ABI,
                functionName: "revoke",
                args: [commitment, lowLeafIndex, proof]
            })
            return { txHash }
        } catch (error) {
            const errorName = revertErrorName(error)
            if (errorName !== undefined) throw new RevocationRevertError(errorName, error)
            throw error
        }
    }
}

/** The registry error name `revertReason` decodes to, falling back to the raw data so a caller
 *  that can't match a name still has something to report. */
function decodedRevertReason(revertReason: Hex | undefined): string {
    if (revertReason === undefined) return "reverted without a reason"
    try {
        return decodeErrorResult({ abi: CREDENTIAL_REVOCATION_REGISTRY_ABI, data: revertReason }).errorName
    } catch {
        return revertReason
    }
}
