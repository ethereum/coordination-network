import { p256 } from "@noble/curves/nist.js"
import { secp256k1 } from "@noble/curves/secp256k1"
import { hexToBytes, randomBytes } from "@noble/hashes/utils"
import {
    buildDeviceBindingMessage,
    computeNetworkId,
    deriveEddsaKeypair,
    deriveKeys,
    eddsaPeerPointBytes,
    encodeMetaStealthAddress,
    signAccountBinding
} from "@coordination-network/identity"
import type { Hex, Secp256k1Keypair } from "@coordination-network/identity"
import {
    deriveRevocationCommitment,
    generateRevocationSecret,
    Hex32,
    InMemoryResolver,
    issuanceRequestCommitment,
    jwkToPublicKeyBytes,
    LocalCredentialSigner,
    LocalP256Signer,
    signCommitmentOwnership,
    signHolderKeyOwnership,
    ZkCredentialIssueParams
} from "@coordination-network/credential"
import { ApprovedIssuerSet, ContractLeafReader, IssuerPublicKey } from "@coordination-network/issuer-set"

const ISSUER_ID = `0x${"aa".repeat(32)}` as Hex32

const ACCOUNT_PRIVATE_KEY = hexToBytes("07".repeat(32))
const DEVICE_PRIVATE_KEY = hexToBytes("09".repeat(32))
const SUBJECT_ID = computeNetworkId(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, false)) as Hex32

/** An in-memory ContractLeafReader over a fixed set of published issuer keys, for the refresh path without a chain. */
export class FakeIssuerSetReader implements ContractLeafReader {
    private readonly leaves: bigint[]

    constructor(publicKeys: IssuerPublicKey[]) {
        this.leaves = publicKeys.map((key) => ApprovedIssuerSet.leafOf(key))
    }

    async getLeafCount(): Promise<number> {
        return this.leaves.length
    }

    async getLeaves(start: number, end: number): Promise<bigint[]> {
        return this.leaves.slice(start, end)
    }
}

export interface IssueVCFixture {
    params: ZkCredentialIssueParams
    signer: LocalCredentialSigner
    resolver: InMemoryResolver
}

/** A fully valid issueVC() input: signed dual proof-of-possession, a revocation commitment, and an approved issuer. */
export async function createIssueVCFixture(): Promise<IssueVCFixture> {
    const signer = new LocalCredentialSigner("network-member-client-fixture-issuer")
    const deviceSigner = new LocalP256Signer(DEVICE_PRIVATE_KEY)
    const confirmationKey = await deviceSigner.getPublicKeyJwk()
    const confirmationKeyBytes = jwkToPublicKeyBytes(confirmationKey)

    const eddsa = deriveEddsaKeypair(p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33))
    const holderKeyCommitment = hexToBytes(eddsa.commitment.toString(16).padStart(64, "0"))

    const approvalScope = { programme: "test-programme", country: "ZZZ" }
    const nonce = randomBytes(32)
    const devicePopSignature = await deviceSigner.sign(
        buildDeviceBindingMessage(
            nonce,
            SUBJECT_ID,
            holderKeyCommitment,
            issuanceRequestCommitment(ISSUER_ID, approvalScope)
        )
    )
    const accountPopSignature = hexToBytes(
        signAccountBinding(ACCOUNT_PRIVATE_KEY, nonce, confirmationKeyBytes).signature.slice(2)
    )

    const r = generateRevocationSecret()
    const ownership = signCommitmentOwnership(r, nonce)
    const holderOwnership = signHolderKeyOwnership(hexToBytes(eddsa.seed.slice(2)), nonce)

    const now = Math.floor(Date.now() / 1000)
    const params: ZkCredentialIssueParams = {
        issuerNetworkId: ISSUER_ID,
        subjectNetworkId: SUBJECT_ID,
        approvalScope,
        validFrom: now - 3600,
        validUntil: now + 3600,
        confirmationKey,
        accountPublicKey: secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, true),
        nonce,
        devicePopSignature,
        accountPopSignature,
        identityPublicKey: eddsa.publicKey,
        identityOwnershipSignature: holderOwnership.signature,
        revocation: {
            commitment: deriveRevocationCommitment(r),
            publicKey: ownership.publicKey,
            ownershipSignature: ownership.signature
        }
    }

    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)

    return { params, signer, resolver }
}

const RECIPIENT_DEVICE_SECRET = hexToBytes("cc".repeat(32))

export interface DeliverToStealthFixture {
    spending: Secp256k1Keypair
    viewing: Secp256k1Keypair
    metaStealthAddress: Hex
}

/** A recipient's real spending/viewing keypair and the meta-stealth address it encodes to. */
export function createDeliverToStealthFixture(): DeliverToStealthFixture {
    const { spending, viewing } = deriveKeys(RECIPIENT_DEVICE_SECRET)
    const metaStealthAddress = encodeMetaStealthAddress({
        spendingPublicKey: spending.publicKey,
        viewingPublicKey: viewing.publicKey
    })

    return { spending, viewing, metaStealthAddress }
}
