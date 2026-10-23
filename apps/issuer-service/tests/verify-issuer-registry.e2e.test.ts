import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { after, before, describe, test } from "node:test"
import { getCurveFromName, type Curve } from "ffjavascript"
import { p256 } from "@noble/curves/nist.js"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import {
    buildDeviceBindingMessage,
    computeNetworkId,
    deriveEddsaKeypair,
    eddsaPeerPointBytes,
    signAccountBinding
} from "@coordination-network/identity"
import {
    ApprovedIssuerSet,
    buildZkPresentationInputs,
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
    ZkCredentialCircuit,
    ZkCredentialProofSystem,
    ZkPresentationProof
} from "@coordination-network/credential"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { buildServer } from "../src/server"
import { credentialArtifactPath } from "@coordination-network/zk-artifacts"

// No anvil: the server below keeps buildServer's default in-memory issuer set and revocation
// backing, which is enough to reach the branch this test pins.
const ISSUER_B_ID = `0x${"b7".repeat(32)}` as Hex32
const ACCOUNT_PRIVATE_KEY = hexToBytes("61".repeat(32))
const DEVICE_PRIVATE_KEY = hexToBytes("62".repeat(32))
const SUBJECT_ID = computeNetworkId(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, false)) as Hex32
const CIRCUIT_PATH = credentialArtifactPath("circuit.json")
const CIRCUIT = JSON.parse(readFileSync(CIRCUIT_PATH, "utf8")) as ZkCredentialCircuit
const PROGRAMME = "demo-programme"
const COUNTRY = "ZZZ"

function toHex(bytes: Uint8Array): `0x${string}` {
    return `0x${bytesToHex(bytes)}`
}

function listen(app: ReturnType<typeof buildServer>): { base: string; close: () => void } {
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    return { base: `http://127.0.0.1:${port}`, close: () => listener.close() }
}

interface PresentationRequest {
    requestId: string
    challenge: string
    audience: string
    currentTime: number
    programme: string
    country: string
}

async function requestPresentation(base: string): Promise<PresentationRequest> {
    const res = await fetch(`${base}/v1/presentation-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ programme: PROGRAMME, country: COUNTRY })
    })
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()))
    return (await res.json()) as PresentationRequest
}

const toRequest = (request: PresentationRequest) => ({
    challenge: hexToBytes(request.challenge.slice(2)),
    audience: request.audience,
    currentTime: request.currentTime,
    programme: request.programme,
    country: request.country
})

interface VerifyResult {
    verificationId?: string
    ok: boolean
    code?: string
}

async function verify(base: string, requestId: string, proof: ZkPresentationProof): Promise<VerifyResult> {
    const res = await fetch(`${base}/v1/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, proof: toHex(proof.proof), publicInputs: proof.publicInputs })
    })
    assert.equal(res.status, 200)
    return (await res.json()) as VerifyResult
}

/** The holder-side dance `POST /v1/credentials` demands, run against one server's own endpoints. */
async function issueCredential(base: string, issuerNetworkId: Hex32, deviceSigner: LocalP256Signer) {
    const confirmationKey = await deviceSigner.getPublicKeyJwk()
    const holder = deriveEddsaKeypair(p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33))
    const approvalScope = { programme: PROGRAMME, country: COUNTRY }
    const revocationSecret = generateRevocationSecret()
    const commitment = deriveRevocationCommitment(revocationSecret)

    const { challengeId, nonce: nonceHex } = (await (
        await fetch(`${base}/v1/challenge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subjectNetworkId: SUBJECT_ID })
        })
    ).json()) as { challengeId: string; nonce: string }
    const nonce = hexToBytes(nonceHex)
    const ownership = signCommitmentOwnership(revocationSecret, nonce)
    const holderOwnership = signHolderKeyOwnership(hexToBytes(holder.seed.slice(2)), nonce)

    const res = await fetch(`${base}/v1/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            challengeId,
            subjectNetworkId: SUBJECT_ID,
            approvalScope,
            confirmationKey,
            accountPublicKey: bytesToHex(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, true)),
            devicePopSignature: bytesToHex(
                await deviceSigner.sign(
                    buildDeviceBindingMessage(
                        nonce,
                        SUBJECT_ID,
                        hexToBytes(holder.commitment.toString(16).padStart(64, "0")),
                        issuanceRequestCommitment(issuerNetworkId, approvalScope)
                    )
                )
            ),
            accountPopSignature: signAccountBinding(
                ACCOUNT_PRIVATE_KEY,
                nonce,
                jwkToPublicKeyBytes(confirmationKey)
            ).signature.slice(2),
            identityPublicKey: holder.publicKey.map(String),
            identityOwnershipSignature: {
                R8: holderOwnership.signature.R8.map(String),
                S: holderOwnership.signature.S.toString()
            },
            revocation: {
                commitment: commitment.toString(),
                publicKey: ownership.publicKey.map(String),
                ownershipSignature: { R8: ownership.signature.R8.map(String), S: ownership.signature.S.toString() }
            }
        })
    })
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()))
    const { id, credential } = (await res.json()) as { id: string; credential: unknown }

    return {
        id,
        credential,
        holder: { identitySeed: hexToBytes(holder.seed.slice(2)), revocationSecret, deviceSigner }
    }
}

describe("POST /v1/verify: the issuer-root branch (no anvil)", () => {
    let server: { base: string; close: () => void }
    let proofSystem: ZkCredentialProofSystem
    let request: PresentationRequest
    let proof: ZkPresentationProof

    before(async () => {
        const signer = new LocalCredentialSigner("issuer-service-registry-b")
        const keyB = await signer.getPublicKey()
        const keyC = await new LocalCredentialSigner("issuer-service-registry-c").getPublicKey()

        const resolver = new InMemoryResolver()
        resolver.approveMember(ISSUER_B_ID)
        server = listen(
            buildServer({
                issuerNetworkId: ISSUER_B_ID,
                signer,
                resolver,
                issuerPublicKeys: [keyC],
                minDeviceSecurityLevel: "SOFTWARE",
                identityReader: { getIdentity: async () => "0x1234" },
                issuancePolicy: { decideIssuance: async () => ({ programme: PROGRAMME, country: COUNTRY }) },
                credentialCircuitPath: CIRCUIT_PATH,
                verifyMaxSkewSeconds: 86_400,
                presentationRequestTtlSeconds: 86_400
            })
        )

        const issued = await issueCredential(server.base, ISSUER_B_ID, new LocalP256Signer(DEVICE_PRIVATE_KEY))
        request = await requestPresentation(server.base)

        const wrongKey = await new LocalCredentialSigner("issuer-service-registry-wrong").getPublicKey()
        proofSystem = await ZkCredentialProofSystem.create(CIRCUIT, { backend: { threads: 1 } })
        proof = await proofSystem.generateProof(
            await buildZkPresentationInputs(
                issued.credential,
                issued.holder,
                // Not the set this server serves, so its root is not one the server accepts; the
                // baked-in revocation root (0, from the empty tree) is also made stale by the
                // revoke below, so both checks would fail if either ran.
                { approvedIssuers: new ApprovedIssuerSet([wrongKey, keyB]), revocations: new RevocationRegistry() },
                toRequest(request)
            )
        )

        // Only after the proof is built: this is what makes its baked-in revocation root stale
        // without touching the proof itself.
        const revoked = await fetch(`${server.base}/v1/credentials/${issued.id}/revoke`, { method: "POST" })
        assert.equal(revoked.status, 200)
    })

    after(async () => {
        await proofSystem?.destroy()
        server?.close()
    })

    test("a proof over a set that is not the live approved set is ISSUER_ROOT_MISMATCH, and names nothing", async () => {
        const body = await verify(server.base, request.requestId, proof)

        assert.equal(body.ok, false)
        assert.equal(body.code, "ISSUER_ROOT_MISMATCH")

        // The issuer root is checked before the revocation root, and neither branch can name an
        // issuer: a presentation proves membership in the whole set, so there is no leaf to report.
        const stored = (await (await fetch(`${server.base}/v1/verifications/${body.verificationId}`)).json()) as Record<
            string,
            unknown
        >
        assert.equal(stored.code, "ISSUER_ROOT_MISMATCH")
        assert.equal("issuerLeaf" in stored, false)
    })
})

// snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
let curve: Curve

before(async () => {
    curve = await getCurveFromName("bn128")
})

after(async () => {
    await curve.terminate()
})
