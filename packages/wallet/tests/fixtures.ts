import { p256 } from "@noble/curves/nist.js"
import { hexToBytes } from "@noble/hashes/utils"
import {
    buildDeviceBindingMessage,
    deriveEddsaKeypair,
    deriveKeys,
    eddsaPeerPointBytes,
    signAccountBinding
} from "@coordination-network/identity"
import {
    deriveRevocationCommitment,
    InMemoryResolver,
    issuanceRequestCommitment,
    issueZkCredential,
    jwkToPublicKeyBytes,
    LocalCredentialSigner,
    LocalP256Signer,
    serializeZkCredential,
    signCommitmentOwnership,
    signHolderKeyOwnership,
    type SerializedZkCredential,
    type ZkPresentationRequest
} from "@coordination-network/credential"
import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { RevocationRegistry } from "@coordination-network/revocation-registry"

const DEVICE_SECRET = hexToBytes("07".repeat(32))
const DEVICE_PRIVATE_KEY = hexToBytes("09".repeat(32))
export const REVOCATION_SECRET = hexToBytes("0b".repeat(32))
export const REVOCATION_SECRET_2 = hexToBytes("0e".repeat(32))
const NONCE = hexToBytes("0c".repeat(32))
const CHALLENGE = hexToBytes("0d".repeat(31))

export const CREDENTIAL_ID = "urn:uuid:11111111-1111-4111-8111-111111111111"
export const VALID_AT = 1_800_000_000
export const VERIFIER_URN = `urn:cn:network:${"dd".repeat(32)}`

export interface Fixture {
    credential: SerializedZkCredential
    credentialSigner: LocalCredentialSigner
    deviceSigner: LocalP256Signer
    identitySeed: Uint8Array
    revocationSecret: Uint8Array
    chain: {
        approvedIssuers: ApprovedIssuerSet
        approvedIssuerRoot: bigint
        revocations: RevocationRegistry
        revocationRoot: bigint
    }
    request: ZkPresentationRequest
}

/**
 * `issuerSeed` and `revocationSecret` let a test build a second, independently-keyed credential
 * for the same device/identity (e.g. to pin behaviour across two issuers) without colliding with
 * the default fixture's issuer key or revocation commitment.
 */
export async function issueForTest(
    options: { issuerSeed?: string; revocationSecret?: Uint8Array } = {}
): Promise<Fixture> {
    const revocationSecret = options.revocationSecret ?? REVOCATION_SECRET
    const keys = deriveKeys(DEVICE_SECRET)
    const deviceSigner = new LocalP256Signer(DEVICE_PRIVATE_KEY)
    const identity = deriveEddsaKeypair(p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33))
    const confirmationKey = await deviceSigner.getPublicKeyJwk()
    const holderCommitment = hexToBytes(identity.commitment.toString(16).padStart(64, "0"))
    const ownership = signCommitmentOwnership(revocationSecret, NONCE)
    const holderOwnership = signHolderKeyOwnership(hexToBytes(identity.seed.slice(2)), NONCE)
    const credentialSigner = new LocalCredentialSigner(options.issuerSeed ?? "wallet-test-issuer")
    const resolver = new InMemoryResolver()
    const issuerNetworkId = `0x${"aa".repeat(32)}` as const
    const approvalScope = { programme: "test-programme", country: "ZZZ" }
    resolver.approveMember(issuerNetworkId)

    const credential = serializeZkCredential(
        await issueZkCredential(
            {
                issuerNetworkId,
                subjectNetworkId: keys.networkId,
                approvalScope,
                validFrom: VALID_AT - 3_600,
                validUntil: VALID_AT + 3_600,
                confirmationKey,
                accountPublicKey: hexToBytes(keys.account.publicKey.slice(2)),
                nonce: NONCE,
                devicePopSignature: await deviceSigner.sign(
                    buildDeviceBindingMessage(
                        NONCE,
                        keys.networkId,
                        holderCommitment,
                        issuanceRequestCommitment(issuerNetworkId, approvalScope)
                    )
                ),
                accountPopSignature: hexToBytes(
                    signAccountBinding(
                        keys.account.privateKey,
                        NONCE,
                        jwkToPublicKeyBytes(confirmationKey)
                    ).signature.slice(2)
                ),
                identityPublicKey: identity.publicKey,
                identityOwnershipSignature: holderOwnership.signature,
                revocation: {
                    commitment: deriveRevocationCommitment(revocationSecret),
                    publicKey: ownership.publicKey,
                    ownershipSignature: ownership.signature
                }
            },
            credentialSigner,
            resolver
        )
    )

    const approvedIssuers = new ApprovedIssuerSet([await credentialSigner.getPublicKey()])
    const revocations = new RevocationRegistry()

    return {
        credential,
        credentialSigner,
        deviceSigner,
        identitySeed: hexToBytes(identity.seed.slice(2)),
        revocationSecret,
        chain: {
            approvedIssuers,
            approvedIssuerRoot: approvedIssuers.root,
            revocations,
            revocationRoot: revocations.root
        },
        request: {
            challenge: CHALLENGE,
            audience: VERIFIER_URN,
            currentTime: VALID_AT,
            programme: "test-programme",
            country: "ZZZ"
        }
    }
}
