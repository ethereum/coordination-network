import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { after, before, describe, test } from "node:test"
import { getCurveFromName, type Curve } from "ffjavascript"
import { p256 } from "@noble/curves/nist.js"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import {
    Account,
    Chain,
    createPublicClient,
    createWalletClient,
    http,
    PublicClient,
    Transport,
    WalletClient
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
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
import { Identity } from "@semaphore-protocol/identity"
import { ActivityLog } from "../src/activity"
import { buildChainRevocation, RevocationBacking } from "../src/revocation"
import { buildServer } from "../src/server"
import { credentialArtifactPath } from "@coordination-network/zk-artifacts"
import { addMember, advanceTime, deployCredentialRevocationRegistry, startAnvil } from "./chain"

const PORT = 18974
const ISSUER_A_ID = `0x${"a1".repeat(32)}` as Hex32
const ISSUER_B_ID = `0x${"b2".repeat(32)}` as Hex32
const ACCOUNT_PRIVATE_KEY = hexToBytes("41".repeat(32))
const DEVICE_PRIVATE_KEY = hexToBytes("43".repeat(32))
const SUBJECT_ID = computeNetworkId(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, false)) as Hex32
const CIRCUIT_PATH = credentialArtifactPath("circuit.json")
const CIRCUIT = JSON.parse(readFileSync(CIRCUIT_PATH, "utf8")) as ZkCredentialCircuit
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const PROGRAMME = "demo-programme"
const COUNTRY = "ZZZ"
const MEMBER_A_IDENTITY_SECRET = new Uint8Array(32).fill(0xa1)
const MEMBER_B_IDENTITY_SECRET = new Uint8Array(32).fill(0xb2)
/** The registry's own root window, taken from the underlying service's one-hour default. */
const ROOT_GRACE_SECONDS = 3600
/** Revoked before any proof is built, so the tree's pre-revocation root is a real one. The
 *  empty-tree root is 0, which the service never records as superseded — nobody can build a proof
 *  against it, so it gets no grace at all. */
const SEED_COMMITMENT = 987654321n

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

/** The holder-side dance `POST /v1/credentials` demands, run against org A's own endpoints. */
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

describe(`POST /v1/verify across two orgs (anvil, port ${PORT})`, () => {
    let anvil: ChildProcess
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let orgA: { base: string; close: () => void; revocation: RevocationBacking }
    let orgB: { base: string; close: () => void }
    let logB: ActivityLog
    let rpcUrl: string
    let credentialId: string
    let holder: Awaited<ReturnType<typeof issueCredential>>["holder"]
    let proofSystem: ZkCredentialProofSystem
    let approvedIssuers: ApprovedIssuerSet
    let buildProof: (request: PresentationRequest, revocations: RevocationRegistry) => Promise<ZkPresentationProof>
    let okProof: ZkPresentationProof
    let graceProof: ZkPresentationProof
    let expiredProof: ZkPresentationProof
    let requests: { ok: PresentationRequest; grace: PresentationRequest; expired: PresentationRequest }

    before(async () => {
        anvil = await startAnvil(PORT)
        rpcUrl = `http://127.0.0.1:${PORT}`
        publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ANVIL_KEY),
            chain: foundry,
            transport: http(rpcUrl),
            pollingInterval: 50
        })

        // One registry for the whole network, so a revocation at A moves the very root a
        // presentation at B is checked against. Its root window is the underlying service's
        // one-hour default, which the grace cases below depend on.
        const deployment = await deployCredentialRevocationRegistry(wallet, publicClient, wallet.account.address)
        for (const secret of [MEMBER_A_IDENTITY_SECRET, MEMBER_B_IDENTITY_SECRET]) {
            await addMember(
                wallet,
                publicClient,
                deployment.semaphore,
                deployment.semaphoreAbi,
                deployment.groupId,
                new Identity(secret).commitment
            )
        }

        const signerA = new LocalCredentialSigner("issuer-service-two-orgs-a")
        const signerB = new LocalCredentialSigner("issuer-service-two-orgs-b")
        const keyA = await signerA.getPublicKey()
        const keyB = await signerB.getPublicKey()

        const buildOrg = async (
            networkId: Hex32,
            signer: LocalCredentialSigner,
            peerKey: [bigint, bigint],
            memberIdentitySecret: Uint8Array,
            activityLog: ActivityLog
        ) => {
            const resolver = new InMemoryResolver()
            resolver.approveMember(networkId)
            const revocation = await buildChainRevocation(
                {
                    address: deployment.registry,
                    memberIdentitySecret,
                    memberPrivateKey: ANVIL_KEY,
                    memberGroupFromBlock: 0
                },
                rpcUrl,
                resolver
            )
            const listener = listen(
                buildServer({
                    issuerNetworkId: networkId,
                    signer,
                    resolver: revocation,
                    revocation,
                    issuerPublicKeys: [peerKey],
                    minDeviceSecurityLevel: "SOFTWARE",
                    identityReader: { getIdentity: async () => "0x1234" },
                    issuancePolicy: { decideIssuance: async () => ({ programme: PROGRAMME, country: COUNTRY }) },
                    credentialCircuitPath: CIRCUIT_PATH,
                    // Generous: this test's own wall clock fixes a request's currentTime, and
                    // deploying, issuing and proving four times takes real time.
                    verifyMaxSkewSeconds: 86_400,
                    presentationRequestTtlSeconds: 86_400,
                    activityLog
                })
            )
            return { ...listener, revocation }
        }

        logB = new ActivityLog()
        orgA = await buildOrg(ISSUER_A_ID, signerA, keyB, MEMBER_A_IDENTITY_SECRET, new ActivityLog())
        orgB = await buildOrg(ISSUER_B_ID, signerB, keyA, MEMBER_B_IDENTITY_SECRET, logB)

        const issued = await issueCredential(orgA.base, ISSUER_A_ID, new LocalP256Signer(DEVICE_PRIVATE_KEY))
        credentialId = issued.id
        holder = issued.holder
        await orgA.revocation.revoke(SEED_COMMITMENT)

        // Each proof is consumed by exactly one request below; all are built here so the single
        // proof system starts once, and so all three predate the revoke.
        requests = {
            ok: await requestPresentation(orgB.base),
            grace: await requestPresentation(orgB.base),
            expired: await requestPresentation(orgB.base)
        }
        proofSystem = await ZkCredentialProofSystem.create(CIRCUIT, { backend: { threads: 1 } })
        // The order org B's own default set is built in, so this is the very root its
        // approved-issuer set reports as live.
        approvedIssuers = new ApprovedIssuerSet([keyB, keyA])
        buildProof = async (request, revocations) =>
            proofSystem.generateProof(
                await buildZkPresentationInputs(
                    issued.credential,
                    issued.holder,
                    { approvedIssuers, revocations },
                    toRequest(request)
                )
            )

        // The seeded tree, so all three carry the very root the revocation below supersedes.
        const seeded = orgA.revocation.mirror
        okProof = await buildProof(requests.ok, seeded)
        graceProof = await buildProof(requests.grace, seeded)
        expiredProof = await buildProof(requests.expired, seeded)
    })

    after(async () => {
        await proofSystem?.destroy()
        orgA?.close()
        orgB?.close()
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
    })

    test("a proof over the whole approved-issuer set names no issuer, so org B verifies it", async () => {
        const body = await verify(orgB.base, requests.ok.requestId, okProof)
        assert.equal(body.ok, true, body.code ?? "")

        const stored = (await (await fetch(`${orgB.base}/v1/verifications/${body.verificationId}`)).json()) as Record<
            string,
            unknown
        >
        assert.equal(stored.ok, true)
        // Nothing in the record says which of the two orgs signed the credential.
        assert.equal("issuerLeaf" in stored, false)
    })

    test("a proof built before org A's revocation still verifies at org B inside the root grace", async () => {
        const revoked = await fetch(`${orgA.base}/v1/credentials/${credentialId}/revoke`, { method: "POST" })
        assert.equal(revoked.status, 200)

        const body = await verify(orgB.base, requests.grace.requestId, graceProof)
        assert.equal(body.ok, true, body.code ?? "")
    })

    // The case a revoked credential verifies through: org B never wrote to the
    // tree, so its own mirror only moves if it follows the chain. A wallet syncs the snapshot of
    // whichever org is verifying, and a wallet that checks it only against the root served beside
    // the snapshot (the web demo) cannot tell a stale tree from a current one. So a stale snapshot
    // here is a revoked credential presenting successfully, inside the root grace, with the wallet
    // behaving honestly.
    test("org B's snapshot names the revocation org A landed, though org B never wrote to the tree", async () => {
        const commitment = deriveRevocationCommitment(holder.revocationSecret)

        const body = (await (await fetch(`${orgB.base}/v1/revocations/snapshot`)).json()) as {
            root: string
            snapshot: string
        }

        const served = RevocationRegistry.import(body.snapshot)
        assert.equal(served.isRevoked(commitment), true)
        // The pair is self-consistent too, which is all a wallet without a chain read can check.
        assert.equal(served.root.toString(), body.root)
        assert.equal(served.root, orgA.revocation.mirror.root)
    })

    test("the same proof is rejected once the grace has expired", async () => {
        await advanceTime(rpcUrl, ROOT_GRACE_SECONDS + 1)

        const body = await verify(orgB.base, requests.expired.requestId, expiredProof)
        assert.equal(body.ok, false)
        assert.equal(body.code, "REVOCATION_ROOT_INVALID")
    })

    test("once org A revokes, a proof against an empty revocation tree is rejected at org B", async () => {
        // Built against a tree that never saw the revocation. With a registry per issuer this was
        // a bypass: org B's own registry was still empty, so root 0 was its live root forever.
        // One tree leaves root 0 the root of nothing.
        const request = await requestPresentation(orgB.base)
        const bypassProof = await buildProof(request, new RevocationRegistry())

        const body = await verify(orgB.base, request.requestId, bypassProof)
        assert.equal(body.ok, false)
        assert.equal(body.code, "REVOCATION_ROOT_INVALID")
    })

    test("org B's activity log carries the rejection, without naming the credential", async () => {
        const rejections = logB
            .recent()
            .filter((entry) => entry.kind === "verification" && entry.outcome === "failed")
            .map((entry) => entry.message)
        assert.ok(rejections.includes("verification rejected: REVOCATION_ROOT_INVALID"))
        for (const entry of logB.recent()) {
            assert.equal(entry.refs, undefined)
            assert.doesNotMatch(entry.message, new RegExp(credentialId))
        }
    })

    test("closing a request the wallet refused records the refusal at org B", async () => {
        const request = await requestPresentation(orgB.base)
        const res = await fetch(`${orgB.base}/v1/presentation-requests/${request.requestId}/close`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: "CREDENTIAL_REVOKED" })
        })
        assert.equal(res.status, 200, JSON.stringify(await res.clone().json()))
        const { verificationId } = (await res.json()) as { verificationId: string }

        const stored = (await (await fetch(`${orgB.base}/v1/verifications/${verificationId}`)).json()) as {
            ok: boolean
            code: string
            requestId: string
        }
        assert.equal(stored.ok, false)
        assert.equal(stored.code, "CREDENTIAL_REVOKED")
        assert.equal(stored.requestId, request.requestId)
        assert.equal(logB.recent()[0].message, "verification rejected: CREDENTIAL_REVOKED")
        assert.equal(logB.recent()[0].outcome, "failed")
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
