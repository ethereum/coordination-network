import { InvalidBindingInputError, verifyCredentialBinding } from "@coordination-network/identity"
import { inPrimeOrderSubgroup } from "@coordination-network/issuer-set"
import { hexToBytes } from "@noble/hashes/utils"
import { Identity } from "@semaphore-protocol/identity"
import { CredentialSigner } from "./credential-signer"
import {
    countryCode,
    deriveDeviceKeyCommitment,
    issuanceRequestCommitment,
    programmeHash,
    zkCredentialCommitment
} from "./credential-message"
import { jwkToPublicKeyBytes } from "./crypto"
import { IssuanceError } from "./errors"
import { ApprovalResolver } from "./resolver"
import { verifyCommitmentOwnership } from "./revocation"
import { verifyHolderKeyOwnership } from "./holder-ownership"
import { ZkCredential, ZkCredentialBody, ZkCredentialIssueParams } from "./types"

/** Validates an issuance request without signing it. */
export async function validateZkCredentialIssue(
    params: ZkCredentialIssueParams,
    approval: ApprovalResolver
): Promise<ZkCredentialBody> {
    if (!(await approval.isApprovedNetworkMember(params.issuerNetworkId))) {
        throw new IssuanceError(
            "ISSUER_NOT_APPROVED",
            `issuer ${params.issuerNetworkId} is not an approved network member`
        )
    }
    if (!(params.validFrom < params.validUntil)) {
        throw new IssuanceError("INVALID_PARAMS", "validFrom must be before validUntil")
    }

    if (!inPrimeOrderSubgroup(params.identityPublicKey)) {
        throw new IssuanceError("INVALID_PARAMS", "identity public key is not in the prime-order subgroup")
    }

    const holderKeyCommitment = Identity.generateCommitment(params.identityPublicKey)
    const holderKeyCommitmentBytes = hexToBytes(holderKeyCommitment.toString(16).padStart(64, "0"))
    let binding: ReturnType<typeof verifyCredentialBinding>
    try {
        binding = verifyCredentialBinding({
            nonce: params.nonce,
            accountPublicKey: params.accountPublicKey,
            confirmationKey: jwkToPublicKeyBytes(params.confirmationKey),
            holderKeyCommitment: holderKeyCommitmentBytes,
            requestCommitment: issuanceRequestCommitment(params.issuerNetworkId, params.approvalScope),
            accountSignature: params.accountPopSignature,
            deviceSignature: params.devicePopSignature
        })
    } catch (error) {
        if (error instanceof InvalidBindingInputError) {
            throw new IssuanceError("INVALID_PARAMS", `malformed binding input: ${error.message}`)
        }
        throw error
    }

    if (binding.networkId !== params.subjectNetworkId.toLowerCase()) {
        throw new IssuanceError("SUBJECT_MISMATCH", "subjectNetworkId does not match the account public key")
    }
    if (!binding.valid) {
        throw new IssuanceError("BINDING_INVALID", "credential binding failed")
    }

    if (
        !verifyHolderKeyOwnership({
            publicKey: params.identityPublicKey,
            signature: params.identityOwnershipSignature,
            nonce: params.nonce
        })
    ) {
        throw new IssuanceError("HOLDER_KEY_OWNERSHIP_INVALID", "holder key ownership proof failed")
    }

    const ownershipOk = verifyCommitmentOwnership({
        commitment: params.revocation.commitment,
        publicKey: params.revocation.publicKey,
        signature: params.revocation.ownershipSignature,
        nonce: params.nonce
    })
    if (!ownershipOk) {
        throw new IssuanceError("COMMITMENT_OWNERSHIP_INVALID", "revocation commitment ownership proof failed")
    }

    return {
        programmeHash: programmeHash(params.approvalScope.programme),
        countryCode: countryCode(params.approvalScope.country),
        notBefore: params.validFrom,
        expiresAt: params.validUntil,
        deviceKeyCommitment: deriveDeviceKeyCommitment(params.confirmationKey),
        holderKeyCommitment,
        revocationCommitment: params.revocation.commitment
    }
}

/** Signs a request that has already passed {@link validateZkCredentialIssue}. */
export async function signValidatedZkCredential(
    body: ZkCredentialBody,
    signer: CredentialSigner
): Promise<ZkCredential> {
    return {
        body,
        issuerPublicKey: await signer.getPublicKey(),
        signature: await signer.sign(zkCredentialCommitment(body))
    }
}

export async function issueZkCredential(
    params: ZkCredentialIssueParams,
    signer: CredentialSigner,
    approval: ApprovalResolver
): Promise<ZkCredential> {
    return signValidatedZkCredential(await validateZkCredentialIssue(params, approval), signer)
}
