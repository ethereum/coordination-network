import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import type { ContractLeafReader, IssuerMembershipWitness, IssuerPublicKey } from "@coordination-network/issuer-set"
import { NetworkMemberClientError } from "./errors"

export interface FetchIssuerMembershipWitnessParams {
    issuerSetReader: ContractLeafReader
    issuerPublicKey: IssuerPublicKey
}

export interface IssuerMembershipWitnessResult {
    root: bigint
    witness: IssuerMembershipWitness
}

/** Rebuilds the approved-issuer set from its current on-chain leaves and proves membership against the fresh root. */
export async function fetchIssuerMembershipWitness({
    issuerSetReader,
    issuerPublicKey
}: FetchIssuerMembershipWitnessParams): Promise<IssuerMembershipWitnessResult> {
    const issuerSet = await ApprovedIssuerSet.fromContract(issuerSetReader)

    if (!issuerSet.isApproved(issuerPublicKey)) {
        throw new NetworkMemberClientError(
            "ISSUER_KEY_NOT_PUBLISHED",
            "issuer signing key is not published to the approved-issuer set"
        )
    }

    return { root: issuerSet.root, witness: issuerSet.generateProof(issuerPublicKey) }
}
