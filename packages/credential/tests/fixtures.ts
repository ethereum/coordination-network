import { p256 } from "@noble/curves/nist.js"
import { secp256k1 } from "@noble/curves/secp256k1"
import { hexToBytes, randomBytes } from "@noble/hashes/utils"
import {
    buildDeviceBindingMessage,
    computeNetworkId,
    deriveEddsaKeypair,
    eddsaPeerPointBytes,
    signAccountBinding
} from "@coordination-network/identity"
import { SNARK_SCALAR_FIELD } from "@coordination-network/issuer-set"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { Identity } from "@semaphore-protocol/identity"
import { Base8, mulPointEscalar, subOrder } from "@zk-kit/baby-jubjub"
import { poseidon5 } from "poseidon-lite/poseidon5"
import {
    ApprovalScope,
    ApprovedIssuerSet,
    deriveRevocationCommitment,
    EddsaPublicKey,
    EddsaSignature,
    generateRevocationSecret,
    Hex32,
    InMemoryResolver,
    issuanceRequestCommitment,
    issueZkCredential,
    jwkToPublicKeyBytes,
    LocalCredentialSigner,
    LocalP256Signer,
    serializeZkCredential,
    SerializedZkCredential,
    signCommitmentOwnership,
    signHolderKeyOwnership,
    ZkCredentialIssueParams,
    ZkPresentationChainState,
    ZkPresentationHolder,
    ZkPresentationRequest
} from "@coordination-network/credential"

export const ISSUER_ID = `0x${"aa".repeat(32)}` as Hex32
export const OTHER_ISSUER_ID = `0x${"bb".repeat(32)}` as Hex32
const ACCOUNT_PRIVATE_KEY = hexToBytes("07".repeat(32))
export const SUBJECT_ID = computeNetworkId(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, false)) as Hex32
export const VERIFIER_URN = `urn:cn:network:${"dd".repeat(32)}`

/** What the wallet signs with the device key: the holder key and the issuer and scope it consented to. */
export function signDevicePop(
    deviceSigner: LocalP256Signer,
    nonce: Uint8Array,
    identityPublicKey: EddsaPublicKey,
    issuerNetworkId: Hex32,
    approvalScope: ApprovalScope
): Promise<Uint8Array> {
    const holderKeyCommitment = hexToBytes(
        Identity.generateCommitment(identityPublicKey).toString(16).padStart(64, "0")
    )

    return deviceSigner.sign(
        buildDeviceBindingMessage(
            nonce,
            SUBJECT_ID,
            holderKeyCommitment,
            issuanceRequestCommitment(issuerNetworkId, approvalScope)
        )
    )
}

export interface IssuanceFixture {
    params: ZkCredentialIssueParams
    deviceSigner: LocalP256Signer
    resolver: InMemoryResolver
    r: Uint8Array
    commitment: bigint
    nonce: Uint8Array
    now: number
}

/** Overrides for the parts a caller needs to hold fixed. Everything else is fresh per call. */
export interface IssuanceFixtureOptions {
    device?: LocalP256Signer
    nonce?: Uint8Array
    r?: Uint8Array
    identityPublicKey?: EddsaPublicKey
    /** Validity window midpoint, unix seconds. Defaults to now. */
    now?: number
}

/**
 * Valid issuance request + resolver with two approved issuers; the device signature is bound to `ISSUER_ID`
 * and the default scope. Tests mutate copies to hit failure paths.
 */
export async function createIssuanceFixture(options: IssuanceFixtureOptions = {}): Promise<IssuanceFixture> {
    const deviceSigner = options.device ?? LocalP256Signer.generate()
    const accountPublicKey = secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, true)

    const nonce = options.nonce ?? randomBytes(32)
    const r = options.r ?? generateRevocationSecret()
    const commitment = deriveRevocationCommitment(r)
    const ownership = signCommitmentOwnership(r, nonce)
    const confirmationKey = await deviceSigner.getPublicKeyJwk()
    const confirmationKeyBytes = jwkToPublicKeyBytes(confirmationKey)

    const approvalScope = { programme: "test-programme", country: "ZZZ" }
    const holderOwnership = signHolderKeyOwnership(hexToBytes("0d".repeat(32)), nonce)
    const identityPublicKey = options.identityPublicKey ?? holderOwnership.publicKey
    const devicePopSignature = await signDevicePop(deviceSigner, nonce, identityPublicKey, ISSUER_ID, approvalScope)
    const accountPopSignature = hexToBytes(
        signAccountBinding(ACCOUNT_PRIVATE_KEY, nonce, confirmationKeyBytes).signature.slice(2)
    )

    const now = options.now ?? Math.floor(Date.now() / 1000)
    const params: ZkCredentialIssueParams = {
        issuerNetworkId: ISSUER_ID,
        subjectNetworkId: SUBJECT_ID,
        approvalScope,
        identityPublicKey,
        identityOwnershipSignature: holderOwnership.signature,
        validFrom: now - 3600,
        validUntil: now + 3600,
        confirmationKey,
        accountPublicKey,
        nonce,
        devicePopSignature,
        accountPopSignature,
        revocation: {
            commitment,
            publicKey: ownership.publicKey,
            ownershipSignature: ownership.signature
        }
    }

    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    resolver.approveMember(OTHER_ISSUER_ID)

    return { params, deviceSigner, resolver, r, commitment, nonce, now }
}

const DEVICE_PRIVATE_KEY = hexToBytes("09".repeat(32))
const REVOCATION_SECRET = hexToBytes("0a".repeat(32))
const NONCE = hexToBytes("0b".repeat(32))
const CHALLENGE = hexToBytes("0c".repeat(31))
const VALID_AT = 1_760_000_000

export interface ZkFixture {
    credential: SerializedZkCredential
    holder: ZkPresentationHolder
    chain: ZkPresentationChainState & { approvedIssuers: ApprovedIssuerSet }
    request: ZkPresentationRequest
    credentialSigner: LocalCredentialSigner
}

export async function createZkFixture(): Promise<ZkFixture> {
    const deviceSigner = new LocalP256Signer(DEVICE_PRIVATE_KEY)
    const base = await createIssuanceFixture({
        device: deviceSigner,
        nonce: NONCE,
        r: REVOCATION_SECRET,
        now: VALID_AT
    })

    const sharedSecret = p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33)
    const eddsa = deriveEddsaKeypair(sharedSecret)

    const credentialSigner = new LocalCredentialSigner("cn-fixture-issuer")
    const otherCredentialSigner = new LocalCredentialSigner("cn-fixture-other-issuer")
    const revocations = new RevocationRegistry([deriveRevocationCommitment(hexToBytes("11".repeat(32)))])

    const params: ZkCredentialIssueParams = {
        ...base.params,
        identityPublicKey: eddsa.publicKey,
        identityOwnershipSignature: signHolderKeyOwnership(hexToBytes(eddsa.seed.slice(2)), NONCE).signature,
        devicePopSignature: await signDevicePop(
            deviceSigner,
            NONCE,
            eddsa.publicKey,
            ISSUER_ID,
            base.params.approvalScope
        )
    }
    const credential = serializeZkCredential(await issueZkCredential(params, credentialSigner, base.resolver))
    const approvedIssuers = new ApprovedIssuerSet([
        await otherCredentialSigner.getPublicKey(),
        await credentialSigner.getPublicKey()
    ])

    return {
        credential,
        credentialSigner,
        holder: {
            identitySeed: hexToBytes(eddsa.seed.slice(2)),
            revocationSecret: REVOCATION_SECRET,
            deviceSigner
        },
        chain: { approvedIssuers, revocations },
        request: {
            challenge: CHALLENGE,
            audience: VERIFIER_URN,
            currentTime: base.now,
            programme: base.params.approvalScope.programme,
            country: base.params.approvalScope.country
        }
    }
}

/** Mutates and re-encodes the JWS payload, keeping the original signature. */
export function tamperClaim(token: string, mutate: (payload: Record<string, unknown>) => void): string {
    const [jwt, ...disclosures] = token.split("~")
    const [header, payload, signature] = jwt.split(".")
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    mutate(decoded)
    const reencoded = Buffer.from(JSON.stringify(decoded), "utf8").toString("base64url")
    return [[header, reencoded, signature].join("."), ...disclosures].join("~")
}

/** A low-order point (order 8) that satisfies the curve equation. */
export const TORSION_8: EddsaPublicKey = [
    17545522957889784193459637215142187266023652151580582754000402781682644312291n,
    4826523245007015323400664741523384119579596407052839571721035538011798951543n
]

/** A + (0, -1): on the curve, order 2l, and `8 * A_var == 8 * A`. */
export function withOrderTwoTorsion([x, y]: EddsaPublicKey): EddsaPublicKey {
    return [SNARK_SCALAR_FIELD - x, SNARK_SCALAR_FIELD - y]
}

/**
 * zk-kit's `signMessage` with only the public key fed to the challenge hash changed, so the signature
 * verifies under `publicKey` whenever `8 * publicKey == 8 * identity.publicKey`.
 */
export function signUnderKey(identity: Identity, publicKey: EddsaPublicKey, message: bigint): EddsaSignature {
    const r = 123456789n
    const R8 = mulPointEscalar(Base8, r)
    const hm = poseidon5([R8[0], R8[1], publicKey[0], publicKey[1], message])
    const S = (r + hm * 8n * identity.secretScalar) % subOrder

    return { R8, S }
}

/** Ownership proof for the order-2l variant of the secret `r`'s key. zk-kit verifies its signature. */
export function mixedOrderRevocation(r: Uint8Array, nonce: Uint8Array) {
    const identity = new Identity(r)
    const publicKey = withOrderTwoTorsion([identity.publicKey[0], identity.publicKey[1]])

    return {
        commitment: Identity.generateCommitment(publicKey),
        publicKey,
        ownershipSignature: signUnderKey(identity, publicKey, BigInt(`0x${Buffer.from(nonce).toString("hex")}`))
    }
}

/** Ownership proof under a low-order key, forgeable by anyone: 8 * A is the identity, so S = r works. */
export function lowOrderRevocation() {
    const S = 987654321n
    const R8 = mulPointEscalar(Base8, S)

    return {
        commitment: Identity.generateCommitment(TORSION_8),
        publicKey: TORSION_8,
        ownershipSignature: { R8, S }
    }
}
