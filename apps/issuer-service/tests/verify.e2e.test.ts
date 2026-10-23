import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { after, before, describe, test } from "node:test"
import { getCurveFromName, type Curve } from "ffjavascript"
import { p256 } from "@noble/curves/nist.js"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import {
    createPublicClient,
    createWalletClient,
    http,
    PublicClient,
    Transport,
    Chain,
    Account,
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
import { buildChainRevocation } from "../src/revocation"
import { buildServer } from "../src/server"
import { ServerDeps } from "../src/types"
import {
    DeployedCredentialRevocationRegistry,
    addMember,
    advanceTime,
    deployCredentialRevocationRegistry,
    startAnvil
} from "./chain"
import { credentialArtifactPath } from "@coordination-network/zk-artifacts"

const PORT = 18973
const ISSUER_ID = `0x${"ff".repeat(32)}` as Hex32
const SCOPE = { programme: "demo-programme", country: "ZZZ" }
const ACCOUNT_PRIVATE_KEY = hexToBytes("21".repeat(32))
const DEVICE_PRIVATE_KEY = hexToBytes("23".repeat(32))
const SUBJECT_ID = computeNetworkId(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, false)) as Hex32
const CIRCUIT_PATH = credentialArtifactPath("circuit.json")
const CIRCUIT = JSON.parse(readFileSync(CIRCUIT_PATH, "utf8")) as ZkCredentialCircuit
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const MEMBER_IDENTITY_SECRET = new Uint8Array(32).fill(0xff)

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
    expiresAt: number
}

async function requestPresentation(base: string, programme: string, country: string): Promise<PresentationRequest> {
    const res = await fetch(`${base}/v1/presentation-requests`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ programme, country })
    })
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()))
    return (await res.json()) as PresentationRequest
}

describe(`POST /v1/verify (anvil, port ${PORT})`, () => {
    let anvil: ChildProcess
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let base: string
    let close: () => void
    let deployment: DeployedCredentialRevocationRegistry
    let issuerPublicKey: [bigint, bigint]
    let activityLog: ActivityLog

    before(async () => {
        anvil = await startAnvil(PORT)
        const rpcUrl = `http://127.0.0.1:${PORT}`
        publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ANVIL_KEY),
            chain: foundry,
            transport: http(rpcUrl),
            pollingInterval: 50
        })
        deployment = await deployCredentialRevocationRegistry(wallet, publicClient, wallet.account.address)
        // The registry reads no msg.sender: what authorises a revoke is membership in this group.
        await addMember(
            wallet,
            publicClient,
            deployment.semaphore,
            deployment.semaphoreAbi,
            deployment.groupId,
            new Identity(MEMBER_IDENTITY_SECRET).commitment
        )

        const signer = new LocalCredentialSigner("issuer-service-verify-e2e")
        issuerPublicKey = await signer.getPublicKey()
        const baseResolver = new InMemoryResolver()
        baseResolver.approveMember(ISSUER_ID)

        const revocation = await buildChainRevocation(
            {
                address: deployment.registry,
                memberIdentitySecret: MEMBER_IDENTITY_SECRET,
                memberPrivateKey: ANVIL_KEY,
                memberGroupFromBlock: 0
            },
            rpcUrl,
            baseResolver
        )

        activityLog = new ActivityLog()
        const app = buildServer({
            issuerNetworkId: ISSUER_ID,
            signer,
            resolver: revocation,
            revocation,
            minDeviceSecurityLevel: "SOFTWARE",
            identityReader: { getIdentity: async () => "0x1234" },
            issuancePolicy: {
                decideIssuance: async () => ({ programme: "demo-programme", country: "ZZZ" })
            },
            credentialCircuitPath: CIRCUIT_PATH,
            // Generous: this test's own wall-clock time is what presentation requests capture as
            // currentTime, but deploying contracts and building three proofs takes real time.
            verifyMaxSkewSeconds: 86400,
            activityLog
        })
        ;({ base, close } = listen(app))
    })

    after(async () => {
        close?.()
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
    })

    test("issues, verifies, and revokes a presentation", async (t) => {
        const approvedIssuers = new ApprovedIssuerSet([issuerPublicKey])
        assert.deepEqual(await (await fetch(`${base}/v1/issuers`)).json(), {
            leaves: approvedIssuers.leafSlots.map(String),
            root: approvedIssuers.root.toString(),
            blockNumber: "0",
            approvedIssuerSet: null
        })

        const snapshotBefore = (await (await fetch(`${base}/v1/revocations/snapshot`)).json()) as {
            registryAddress: string
            registryId: string
            root: string
        }
        assert.equal(snapshotBefore.registryAddress.toLowerCase(), deployment.revocation.toLowerCase())
        assert.equal(snapshotBefore.registryId, deployment.registryId.toString())
        assert.equal(snapshotBefore.root, "0")

        const deviceSigner = new LocalP256Signer(DEVICE_PRIVATE_KEY)
        const confirmationKey = await deviceSigner.getPublicKeyJwk()
        const confirmationKeyBytes = jwkToPublicKeyBytes(confirmationKey)
        const holder = deriveEddsaKeypair(p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33))
        const r = generateRevocationSecret()
        const commitment = deriveRevocationCommitment(r)

        const { challengeId, nonce: nonceHex } = (await (
            await fetch(`${base}/v1/challenge`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ subjectNetworkId: SUBJECT_ID })
            })
        ).json()) as { challengeId: string; nonce: string }
        const nonce = hexToBytes(nonceHex)
        const ownership = signCommitmentOwnership(r, nonce)
        const holderOwnership = signHolderKeyOwnership(hexToBytes(holder.seed.slice(2)), nonce)

        const issueRes = await fetch(`${base}/v1/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                challengeId,
                subjectNetworkId: SUBJECT_ID,
                approvalScope: SCOPE,
                confirmationKey,
                accountPublicKey: bytesToHex(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, true)),
                devicePopSignature: bytesToHex(
                    await deviceSigner.sign(
                        buildDeviceBindingMessage(
                            nonce,
                            SUBJECT_ID,
                            hexToBytes(holder.commitment.toString(16).padStart(64, "0")),
                            issuanceRequestCommitment(ISSUER_ID, SCOPE)
                        )
                    )
                ),
                accountPopSignature: signAccountBinding(
                    ACCOUNT_PRIVATE_KEY,
                    nonce,
                    confirmationKeyBytes
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
        assert.equal(issueRes.status, 201, JSON.stringify(await issueRes.clone().json()))
        const issued = (await issueRes.json()) as { id: string; credential: unknown }

        const holderWallet = {
            identitySeed: hexToBytes(holder.seed.slice(2)),
            revocationSecret: r,
            deviceSigner
        }
        const otherIssuer = new LocalCredentialSigner("issuer-service-verify-e2e-other")
        const wrongIssuerSet = new ApprovedIssuerSet([await otherIssuer.getPublicKey(), issuerPublicKey])
        const revocations = new RevocationRegistry()

        // Each request below is consumed by exactly one /v1/verify call further down: since every
        // expected public input comes from the request a proof names, not from the submitter, one
        // proof cannot be replayed against another request's fields (see CONSUMED_REQUEST and
        // PUBLIC_INPUT_MISMATCH further down). All requests and proofs are built up front, before
        // any of them touches /v1/verify, since a presentation request is single-use.
        const requestOk = await requestPresentation(base, "demo-programme", "ZZZ")
        const requestWrongIssuer = await requestPresentation(base, "demo-programme", "ZZZ")
        const requestRevoke = await requestPresentation(base, "demo-programme", "ZZZ")
        const requestMismatch = await requestPresentation(base, "other-programme", "ZZZ")

        const toRequest = (request: PresentationRequest) => ({
            challenge: hexToBytes(request.challenge.slice(2)),
            audience: request.audience,
            currentTime: request.currentTime,
            programme: request.programme,
            country: request.country
        })

        const okInputs = await buildZkPresentationInputs(
            issued.credential,
            holderWallet,
            { approvedIssuers, revocations },
            toRequest(requestOk)
        )
        const wrongIssuerInputs = await buildZkPresentationInputs(
            issued.credential,
            holderWallet,
            { approvedIssuers: wrongIssuerSet, revocations },
            toRequest(requestWrongIssuer)
        )
        // Built against the pre-revocation (empty) tree, then submitted after revoking below: the
        // proof itself stays valid, but its baked-in revocation root no longer matches the chain.
        const revokeInputs = await buildZkPresentationInputs(
            issued.credential,
            holderWallet,
            { approvedIssuers, revocations },
            toRequest(requestRevoke)
        )

        // One proof system for all three proofs: Barretenberg's own startup cost dwarfs a second
        // `generateProof`.
        const proofSystem = await ZkCredentialProofSystem.create(CIRCUIT, { backend: { threads: 1 } })
        let okProof: ZkPresentationProof
        let wrongIssuerProof: ZkPresentationProof
        let revokeProof: ZkPresentationProof
        try {
            okProof = await proofSystem.generateProof(okInputs)
            wrongIssuerProof = await proofSystem.generateProof(wrongIssuerInputs)
            revokeProof = await proofSystem.generateProof(revokeInputs)
        } finally {
            await proofSystem.destroy()
        }

        // #112: measure the real wire encoding, including the hex expansion and all public inputs.
        // buildServer uses Express's default 100 KiB JSON limit. A valid proof must pass that
        // parser in this HTTP E2E test, not just verify directly inside the proof backend.
        const wireBody = JSON.stringify({
            requestId: requestOk.requestId,
            proof: toHex(okProof.proof),
            publicInputs: okProof.publicInputs
        })
        const wireBytes = Buffer.byteLength(wireBody, "utf8")
        assert.ok(wireBytes < 100 * 1024, `presentation JSON is ${wireBytes} bytes, exceeding the server limit`)
        t.diagnostic(
            `WS1 transport: proof=${okProof.proof.byteLength} bytes; JSON=${wireBytes} bytes; public inputs=${okProof.publicInputs.length}`
        )

        // Two concurrent posts for the same requestId, proof and all: the store's consume() claims
        // the request atomically, so exactly one of these can succeed, whichever's claim lands
        // first, and the other sees it already consumed before doing any proof work at all.
        const verifyOk = () =>
            fetch(`${base}/v1/verify`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    requestId: requestOk.requestId,
                    proof: toHex(okProof.proof),
                    publicInputs: okProof.publicInputs
                })
            })
        const [firstRes, secondRes] = await Promise.all([verifyOk(), verifyOk()])
        assert.equal(firstRes.status, 200)
        assert.equal(secondRes.status, 200)
        const [firstBody, secondBody] = (await Promise.all([firstRes.json(), secondRes.json()])) as {
            verificationId: string
            ok: boolean
            code?: string
        }[]
        const succeeded = [firstBody, secondBody].filter((body) => body.ok)
        const consumed = [firstBody, secondBody].filter((body) => !body.ok)
        assert.equal(succeeded.length, 1)
        assert.equal(consumed.length, 1)
        assert.equal(consumed[0].code, "CONSUMED_REQUEST")
        const okBody = succeeded[0]
        assert.ok(okBody.verificationId)

        const stored = await (await fetch(`${base}/v1/verifications/${okBody.verificationId}`)).json()
        assert.deepEqual(stored, {
            verificationId: okBody.verificationId,
            ok: true,
            requestId: requestOk.requestId,
            audience: requestOk.audience,
            currentTime: requestOk.currentTime,
            challenge: requestOk.challenge,
            programme: requestOk.programme,
            country: requestOk.country,
            verifiedAt: (stored as { verifiedAt: number }).verifiedAt
        })

        assert.equal((await fetch(`${base}/v1/verifications/urn:uuid:not-a-real-one`)).status, 404)

        // A further replay, after the race above already settled, still reports CONSUMED_REQUEST.
        const replayRes = await verifyOk()
        assert.equal(replayRes.status, 200)
        const replayBody = (await replayRes.json()) as { ok: boolean; code?: string }
        assert.equal(replayBody.ok, false)
        assert.equal(replayBody.code, "CONSUMED_REQUEST")
        // The verifier's phone did not receive the wallet callback. It discovers the original
        // result through its own request ID, even after the racing/replayed POSTs above.
        const crossDeviceResult = await fetch(`${base}/v1/presentation-requests/${requestOk.requestId}`)
        assert.equal(crossDeviceResult.status, 200)
        const crossDeviceBody = (await crossDeviceResult.json()) as {
            status: string
            verification: { verificationId: string; ok: boolean; requestId: string }
        }
        assert.equal(crossDeviceBody.status, "completed")
        assert.equal(crossDeviceBody.verification.verificationId, okBody.verificationId)
        assert.equal(crossDeviceBody.verification.requestId, requestOk.requestId)
        assert.equal(crossDeviceBody.verification.ok, true)

        const unknownRes = await fetch(`${base}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                requestId: "urn:uuid:00000000-0000-0000-0000-000000000000",
                proof: "0x00",
                publicInputs: []
            })
        })
        assert.equal(unknownRes.status, 200)
        assert.deepEqual(await unknownRes.json(), { ok: false, code: "UNKNOWN_REQUEST" })

        // okProof was built for requestOk's "demo-programme"; submitted against requestMismatch's
        // "other-programme" (and its own distinct challenge/currentTime), the proof's baked-in
        // public inputs no longer match what the verifier derives from the request it names.
        const mismatchRes = await fetch(`${base}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                requestId: requestMismatch.requestId,
                proof: toHex(okProof.proof),
                publicInputs: okProof.publicInputs
            })
        })
        assert.equal(mismatchRes.status, 200)
        const mismatchBody = (await mismatchRes.json()) as { ok: boolean; code?: string }
        assert.equal(mismatchBody.ok, false)
        assert.equal(mismatchBody.code, "PUBLIC_INPUT_MISMATCH")

        const wrongIssuerRes = await fetch(`${base}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                requestId: requestWrongIssuer.requestId,
                proof: toHex(wrongIssuerProof.proof),
                publicInputs: wrongIssuerProof.publicInputs
            })
        })
        assert.equal(wrongIssuerRes.status, 200)
        const wrongIssuerBody = (await wrongIssuerRes.json()) as { ok: boolean; code?: string }
        assert.equal(wrongIssuerBody.ok, false)
        assert.equal(wrongIssuerBody.code, "ISSUER_ROOT_MISMATCH")

        const revokeRes = await fetch(`${base}/v1/credentials/${issued.id}/revoke`, { method: "POST" })
        assert.equal(revokeRes.status, 200)

        assert.equal(
            await publicClient.readContract({
                address: deployment.revocation,
                abi: deployment.revocationAbi,
                functionName: "isRevoked",
                args: [deployment.registryId, commitment]
            }),
            true
        )

        const snapshotAfter = (await (await fetch(`${base}/v1/revocations/snapshot`)).json()) as { root: string }
        assert.notEqual(snapshotAfter.root, "0")

        // The empty root remains valid during the same grace window as later roots.
        assert.equal(
            await publicClient.readContract({
                address: deployment.registry,
                abi: deployment.registryAbi,
                functionName: "isValidRoot",
                args: [0n]
            }),
            true
        )
        await advanceTime(`http://127.0.0.1:${PORT}`, 3600)

        const afterRevocationRes = await fetch(`${base}/v1/verify`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                requestId: requestRevoke.requestId,
                proof: toHex(revokeProof.proof),
                publicInputs: revokeProof.publicInputs
            })
        })
        assert.equal(afterRevocationRes.status, 200)
        const afterRevocationBody = (await afterRevocationRes.json()) as { ok: boolean; code?: string }
        assert.equal(afterRevocationBody.ok, false)
        assert.equal(afterRevocationBody.code, "REVOCATION_ROOT_INVALID")

        // The feed is public: no entry may carry a ref (registration and verification refs would
        // each resolve to the user they were issued for) or name the credential or verification id
        // that gate their own endpoints. This server has no governance config, so /v1/activity
        // isn't mounted; read the log the server was built with directly instead.
        for (const entry of activityLog.recent()) {
            assert.equal(entry.refs, undefined)
            assert.doesNotMatch(entry.message, new RegExp(issued.id))
            assert.doesNotMatch(entry.message, new RegExp(okBody.verificationId))
        }
    })
})

// These never reach proof verification, so unlike the suite above they need no anvil, no
// credential, and no circuit.
describe("POST /v1/verify: presentation-request lifecycle", () => {
    function lightweightServer(overrides: Partial<ServerDeps> = {}) {
        const signer = new LocalCredentialSigner("issuer-service-verify-lifecycle")
        const resolver = new InMemoryResolver()
        resolver.approveMember(ISSUER_ID)
        return buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver, ...overrides })
    }

    test("an unknown requestId reports UNKNOWN_REQUEST", async () => {
        const { base, close } = listen(lightweightServer())
        try {
            const res = await fetch(`${base}/v1/verify`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    requestId: "urn:uuid:00000000-0000-0000-0000-000000000000",
                    proof: "0x00",
                    publicInputs: []
                })
            })
            assert.equal(res.status, 200)
            assert.deepEqual(await res.json(), { ok: false, code: "UNKNOWN_REQUEST" })
        } finally {
            close()
        }
    })

    test("a request older than PRESENTATION_REQUEST_TTL_SECONDS reports EXPIRED_REQUEST", async () => {
        const { base, close } = listen(lightweightServer({ presentationRequestTtlSeconds: 1 }))
        try {
            const created = await requestPresentation(base, "demo-programme", "ZZZ")
            // currentTime/expiresAt are whole seconds (Math.floor), so a wait just over 1s can
            // still floor to a 1s (not >1s) difference depending on where creation fell within its
            // own second; over 2s guarantees the difference exceeds the 1s TTL either way.
            await new Promise((resolve) => setTimeout(resolve, 2200))

            const res = await fetch(`${base}/v1/verify`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ requestId: created.requestId, proof: "0x00", publicInputs: [] })
            })
            assert.equal(res.status, 200)
            const body = (await res.json()) as { ok: boolean; code?: string }
            assert.equal(body.ok, false)
            assert.equal(body.code, "EXPIRED_REQUEST")
        } finally {
            close()
        }
    })

    test("a request older than VERIFY_MAX_SKEW_SECONDS, but not yet expired, reports STALE_CURRENT_TIME", async () => {
        const { base, close } = listen(
            lightweightServer({ verifyMaxSkewSeconds: 1, presentationRequestTtlSeconds: 300 })
        )
        try {
            const created = await requestPresentation(base, "demo-programme", "ZZZ")
            // Same whole-second rounding margin as the EXPIRED_REQUEST test above.
            await new Promise((resolve) => setTimeout(resolve, 2200))

            const res = await fetch(`${base}/v1/verify`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ requestId: created.requestId, proof: "0x00", publicInputs: [] })
            })
            assert.equal(res.status, 200)
            const body = (await res.json()) as { ok: boolean; code?: string }
            assert.equal(body.ok, false)
            assert.equal(body.code, "STALE_CURRENT_TIME")
        } finally {
            close()
        }
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
