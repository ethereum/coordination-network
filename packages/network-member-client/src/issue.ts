import { issueZkCredential, serializeZkCredential } from "@coordination-network/credential"
import type { ApprovalResolver, CredentialSigner, ZkCredentialIssueParams } from "@coordination-network/credential"
import type { ContractLeafReader } from "@coordination-network/issuer-set"
import type { IssuedCredential } from "./types"
import { fetchIssuerMembershipWitness } from "./witness"

export interface IssueVCPorts {
    signer: CredentialSigner
    approval: ApprovalResolver
    issuerSetReader: ContractLeafReader
}

/**
 * Issues a UserApproval credential plus the issuer's fresh Merkle path into the
 * approved-issuer set. The witness is fetched before any signing, so an issuer
 * whose key was never published fails at issuance without spending a signature.
 */
export async function issueVC(
    params: ZkCredentialIssueParams,
    { signer, approval, issuerSetReader }: IssueVCPorts
): Promise<IssuedCredential> {
    const { root, witness } = await fetchIssuerMembershipWitness({
        issuerSetReader,
        issuerPublicKey: await signer.getPublicKey()
    })
    const credential = await issueZkCredential(params, signer, approval)

    return { credential: serializeZkCredential(credential), issuerSetRoot: root, issuerMembershipWitness: witness }
}
