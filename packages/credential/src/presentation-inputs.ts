import { Identity } from "@semaphore-protocol/identity"
import { poseidon2 } from "poseidon-lite/poseidon2"
import { poseidon4 } from "poseidon-lite/poseidon4"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import {
    countryCode,
    deriveDeviceKeyCommitment,
    parseZkCredential,
    programmeHash,
    stringToField,
    verifyZkCredential,
    zkCredentialCommitment
} from "./credential-message"
import { jwkToPublicKeyBytes } from "./crypto"
import { issuerLeaf, ISSUER_SET_MAX_DEPTH, IssuerSet } from "./issuer-set"
import { DeviceSigner } from "./signer"

export const REVOCATION_MAX_DEPTH = 20
// keccak256(utf8("urn:cn:presentation:v1")) >> 8
export const PRESENTATION_DOMAIN = BigInt("47717037732995119958831198142288202228464361330145547649000821135537239485")

interface PaddedPath {
    depth: string
    indices: boolean[]
    siblings: string[]
}

export interface ZkPresentationInputs {
    current_time: string
    challenge: string
    audience: string
    required_programme_hash: string
    required_country_code: string
    credential: {
        programme_hash: string
        country_code: string
        not_before: string
        expires_at: string
        device_key_commitment: string
        holder_key_commitment: string
        revocation_commitment: string
    }
    issuer_pub_x: string
    issuer_pub_y: string
    issuer_sig_r8_x: string
    issuer_sig_r8_y: string
    issuer_sig_s: string
    issuer_depth: string
    issuer_indices: boolean[]
    issuer_siblings: string[]
    device_pub_x: string[]
    device_pub_y: string[]
    device_signature: string[]
    identity_pub_x: string
    identity_pub_y: string
    identity_sig_r8_x: string
    identity_sig_r8_y: string
    identity_sig_s: string
    revocation_pub_x: string
    revocation_pub_y: string
    revocation_sig_r8_x: string
    revocation_sig_r8_y: string
    revocation_sig_s: string
    revocation_low_leaf_value: string
    revocation_low_leaf_next: string
    revocation_depth: string
    revocation_indices: boolean[]
    revocation_siblings: string[]
}

export interface ZkPresentationHolder {
    identitySeed: Uint8Array
    revocationSecret: Uint8Array
    deviceSigner: DeviceSigner
}

export interface IndexedTree {
    root: bigint
    generateProof(value: bigint): {
        proofType: 0 | 1
        root: bigint
        leaf: { value: bigint; nextValue: bigint }
        leafIndex: number
        siblings: bigint[]
    }
}

export interface ZkPresentationChainState {
    approvedIssuers: IssuerSet
    revocations: IndexedTree
}

export interface ZkPresentationRequest {
    challenge: Uint8Array
    audience: string
    currentTime: number
    programme: string
    country: string
}

export const challengeToField = (bytes: Uint8Array): bigint => {
    if (bytes.length !== 31) throw new Error("presentation challenge must be exactly 31 bytes")
    return BigInt(`0x${bytesToHex(bytes)}`)
}

const fieldToBytes = (value: bigint): Uint8Array => hexToBytes(value.toString(16).padStart(64, "0"))

const pathIndices = (leafIndex: number, depth: number): boolean[] =>
    Array.from({ length: depth }, (_, index) => ((leafIndex >> index) & 1) === 1)

function padPath(leafIndex: number, siblings: bigint[], maxDepth: number, label: string): PaddedPath {
    const depth = siblings.length
    if (depth > maxDepth) {
        throw new Error(`${label} path depth ${depth} exceeds the circuit maximum of ${maxDepth}`)
    }
    const pad = <T>(values: T[], filler: T) => [...values, ...Array(maxDepth - values.length).fill(filler)]
    return {
        depth: depth.toString(),
        indices: pad(pathIndices(leafIndex, depth), false),
        siblings: pad(siblings, 0n).map(String)
    }
}

function issuerPath(issuerSet: IssuerSet, publicKey: [bigint, bigint]): PaddedPath {
    const proof = issuerSet.generateProof(publicKey)
    if (proof.root !== issuerSet.root) throw new Error("issuer proof root does not match the approved issuer set")

    const padded = padPath(proof.pathIndex, proof.siblings, ISSUER_SET_MAX_DEPTH, "issuer")

    const depth = proof.siblings.length
    if (!Number.isSafeInteger(proof.pathIndex) || proof.pathIndex < 0 || proof.pathIndex >= 2 ** depth) {
        throw new Error("issuer proof has an invalid path index")
    }

    let node = issuerLeaf(publicKey)
    for (let level = 0; level < depth; level += 1) {
        node = padded.indices[level]
            ? poseidon2([proof.siblings[level], node])
            : poseidon2([node, proof.siblings[level]])
    }
    if (node !== proof.root) throw new Error("issuer proof is invalid")

    return padded
}

export async function buildZkPresentationInputs(
    serializedCredential: unknown,
    holder: ZkPresentationHolder,
    chain: ZkPresentationChainState,
    request: ZkPresentationRequest
): Promise<ZkPresentationInputs> {
    const credential = parseZkCredential(serializedCredential)
    if (!verifyZkCredential(credential)) throw new Error("credential issuer signature is invalid")
    const { body } = credential

    const identity = new Identity(holder.identitySeed)
    if (identity.commitment !== body.holderKeyCommitment) {
        throw new Error("identity seed does not open the credential's holder-key commitment")
    }

    const revocation = new Identity(holder.revocationSecret)
    if (revocation.commitment !== body.revocationCommitment) {
        throw new Error("revocation secret does not open the credential's revocation commitment")
    }

    const devicePublicKey = await holder.deviceSigner.getPublicKeyJwk()
    if (deriveDeviceKeyCommitment(devicePublicKey) !== body.deviceKeyCommitment) {
        throw new Error("device signer does not open the credential's device-key commitment")
    }

    const issuer = issuerPath(chain.approvedIssuers, credential.issuerPublicKey)
    const revocationProof =
        chain.revocations.root === 0n
            ? {
                  proofType: 1 as const,
                  root: 0n,
                  leaf: { value: 0n, nextValue: 0n },
                  leafIndex: 0,
                  siblings: [] as bigint[]
              }
            : chain.revocations.generateProof(body.revocationCommitment)
    if (revocationProof.root !== chain.revocations.root) {
        throw new Error("revocation proof root does not match the supplied revocation tree")
    }
    if (revocationProof.proofType !== 1) throw new Error("credential is revoked")
    const revocationPath = padPath(
        revocationProof.leafIndex,
        revocationProof.siblings,
        REVOCATION_MAX_DEPTH,
        "revocation"
    )

    const challenge = challengeToField(request.challenge)
    const audience = stringToField(request.audience)
    const credentialCommitment = zkCredentialCommitment(body)
    const sessionMessage = poseidon4([PRESENTATION_DOMAIN, challenge, audience, credentialCommitment])
    const identitySignature = identity.signMessage(sessionMessage)
    const revocationSignature = revocation.signMessage(sessionMessage)
    const deviceSignature = await holder.deviceSigner.signDigest(fieldToBytes(sessionMessage))
    if (deviceSignature.length !== 64) throw new Error("device signer must return a compact 64-byte signature")

    const encodedDeviceKey = jwkToPublicKeyBytes(devicePublicKey)
    return {
        current_time: String(request.currentTime),
        challenge: String(challenge),
        audience: String(audience),
        required_programme_hash: String(programmeHash(request.programme)),
        required_country_code: String(countryCode(request.country)),
        credential: {
            programme_hash: String(body.programmeHash),
            country_code: String(body.countryCode),
            not_before: String(body.notBefore),
            expires_at: String(body.expiresAt),
            device_key_commitment: String(body.deviceKeyCommitment),
            holder_key_commitment: String(body.holderKeyCommitment),
            revocation_commitment: String(body.revocationCommitment)
        },
        issuer_pub_x: String(credential.issuerPublicKey[0]),
        issuer_pub_y: String(credential.issuerPublicKey[1]),
        issuer_sig_r8_x: String(credential.signature.R8[0]),
        issuer_sig_r8_y: String(credential.signature.R8[1]),
        issuer_sig_s: String(credential.signature.S),
        issuer_depth: issuer.depth,
        issuer_indices: issuer.indices,
        issuer_siblings: issuer.siblings,
        device_pub_x: Array.from(encodedDeviceKey.slice(1, 33), String),
        device_pub_y: Array.from(encodedDeviceKey.slice(33, 65), String),
        device_signature: Array.from(deviceSignature, String),
        identity_pub_x: String(identity.publicKey[0]),
        identity_pub_y: String(identity.publicKey[1]),
        identity_sig_r8_x: String(identitySignature.R8[0]),
        identity_sig_r8_y: String(identitySignature.R8[1]),
        identity_sig_s: String(identitySignature.S),
        revocation_pub_x: String(revocation.publicKey[0]),
        revocation_pub_y: String(revocation.publicKey[1]),
        revocation_sig_r8_x: String(revocationSignature.R8[0]),
        revocation_sig_r8_y: String(revocationSignature.R8[1]),
        revocation_sig_s: String(revocationSignature.S),
        revocation_low_leaf_value: String(revocationProof.leaf.value),
        revocation_low_leaf_next: String(revocationProof.leaf.nextValue),
        revocation_depth: revocationPath.depth,
        revocation_indices: revocationPath.indices,
        revocation_siblings: revocationPath.siblings
    }
}
