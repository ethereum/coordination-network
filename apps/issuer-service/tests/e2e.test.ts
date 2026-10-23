import assert from "node:assert/strict"
import { ChildProcess, execFileSync, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
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
import { RevocationRegistry } from "@coordination-network/revocation-registry"
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
    parseZkCredential,
    SerializedZkCredential,
    signCommitmentOwnership,
    signHolderKeyOwnership,
    verifyZkCredential,
    ZkCredentialCircuit,
    ZkCredentialProofSystem
} from "@coordination-network/credential"
import { Abi, createPublicClient, createTestClient, createWalletClient, Hex, http, PublicClient } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { buildServer } from "../src/server"
import { credentialArtifactPath } from "@coordination-network/zk-artifacts"

const ISSUER_ID = `0x${"aa".repeat(32)}` as Hex32
const SCOPE = { programme: "demo-programme", country: "ZZZ" }
const ACCOUNT_PRIVATE_KEY = hexToBytes("07".repeat(32))
const DEVICE_PRIVATE_KEY = hexToBytes("09".repeat(32))
const SUBJECT_ID = computeNetworkId(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, false)) as Hex32
const CIRCUIT_PATH = credentialArtifactPath("circuit.json")
const CIRCUIT = JSON.parse(readFileSync(CIRCUIT_PATH, "utf8")) as ZkCredentialCircuit
const CONTRACTS_DIR = join(__dirname, "../../../packages/contracts")
const POSEIDON_T3 = "0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93" as const
const POSEIDON_T4 = "0x4443338EF595F44e0121df4C21102677B142ECF0" as const
const ANVIL_PORT = 18967
const ANVIL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`
const ANVIL_OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const TRUSTED_REGISTRY_ID = 0n

interface DeployedRevocationRegistry {
    abi: Abi
    address: `0x${string}`
    anvil: ChildProcess
    publicClient: PublicClient
}

interface ForgeArtifact {
    abi: Abi
    bytecode: {
        object: string
        linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>
    }
}

async function deployRevocationRegistry(revocationCommitment: bigint): Promise<DeployedRevocationRegistry> {
    execFileSync("forge", ["build"], { cwd: CONTRACTS_DIR, stdio: "ignore" })
    const artifact = JSON.parse(
        readFileSync(join(CONTRACTS_DIR, "out/Revocation.sol/Revocation.json"), "utf8")
    ) as ForgeArtifact
    const poseidonT3 = JSON.parse(
        readFileSync(join(CONTRACTS_DIR, "out/PoseidonT3.sol/PoseidonT3.json"), "utf8")
    ) as ForgeArtifact
    const poseidonT4 = JSON.parse(
        readFileSync(join(CONTRACTS_DIR, "out/PoseidonT4.sol/PoseidonT4.json"), "utf8")
    ) as ForgeArtifact

    const anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--code-size-limit", "1000000"], {
        stdio: "ignore"
    })
    try {
        const publicClient = createPublicClient({ chain: foundry, transport: http(ANVIL_RPC_URL) })
        for (let attempt = 0; ; attempt += 1) {
            try {
                await publicClient.getChainId()
                break
            } catch {
                if (attempt >= 50) throw new Error("anvil did not start")
                await new Promise((resolve) => setTimeout(resolve, 100))
            }
        }

        const owner = privateKeyToAccount(ANVIL_OWNER_KEY)
        const wallet = createWalletClient({ account: owner, chain: foundry, transport: http(ANVIL_RPC_URL) })
        const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(ANVIL_RPC_URL) })
        const deploy = async (library: ForgeArtifact, canonicalAddress: `0x${string}`): Promise<void> => {
            const hash = await wallet.deployContract({
                abi: library.abi,
                bytecode: library.bytecode.object as Hex,
                account: owner,
                chain: foundry
            })
            const receipt = await publicClient.waitForTransactionReceipt({ hash })
            if (!receipt.contractAddress) throw new Error("library deployment failed")
            const code = await publicClient.getBytecode({ address: receipt.contractAddress })
            if (!code) throw new Error("deployed library has no runtime bytecode")
            await testClient.setCode({ address: canonicalAddress, bytecode: code })
        }
        await deploy(poseidonT3, POSEIDON_T3)
        await deploy(poseidonT4, POSEIDON_T4)

        const deployHash = await wallet.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode.object as Hex,
            account: owner,
            chain: foundry
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
        if (!receipt.contractAddress) throw new Error("revocation registry deployment failed")

        const createHash = await wallet.writeContract({
            address: receipt.contractAddress,
            abi: artifact.abi,
            functionName: "createRegistry",
            args: [owner.address],
            account: owner,
            chain: foundry
        })
        await publicClient.waitForTransactionReceipt({ hash: createHash })
        const revokeHash = await wallet.writeContract({
            address: receipt.contractAddress,
            abi: artifact.abi,
            functionName: "revoke",
            args: [TRUSTED_REGISTRY_ID, revocationCommitment, 0n],
            account: owner,
            chain: foundry
        })
        await publicClient.waitForTransactionReceipt({ hash: revokeHash })

        return { abi: artifact.abi, address: receipt.contractAddress, anvil, publicClient }
    } catch (error) {
        anvil.kill()
        throw error
    }
}

test("challenge -> issue -> parse -> prove -> revoke", async () => {
    const signer = new LocalCredentialSigner("issuer-service-e2e")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        minDeviceSecurityLevel: "SOFTWARE",
        identityReader: { getIdentity: async () => "0x1234" },
        issuancePolicy: {
            decideIssuance: async () => ({ programme: "demo-programme", country: "ZZZ" })
        }
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`
    let deployedRevocations: DeployedRevocationRegistry | undefined

    try {
        const deviceSigner = new LocalP256Signer(DEVICE_PRIVATE_KEY)
        const confirmationKey = await deviceSigner.getPublicKeyJwk()
        const confirmationKeyBytes = jwkToPublicKeyBytes(confirmationKey)
        const holder = deriveEddsaKeypair(p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33))
        const r = generateRevocationSecret()
        const commitment = deriveRevocationCommitment(r)

        const challengeRes = await fetch(`${base}/v1/challenge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subjectNetworkId: SUBJECT_ID })
        })
        assert.equal(challengeRes.status, 200)
        const { challengeId, nonce: nonceHex } = (await challengeRes.json()) as {
            challengeId: string
            nonce: string
        }
        const nonce = hexToBytes(nonceHex)
        const ownership = signCommitmentOwnership(r, nonce)
        const holderOwnership = signHolderKeyOwnership(hexToBytes(holder.seed.slice(2)), nonce)

        const issueBody = JSON.stringify({
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
            accountPopSignature: signAccountBinding(ACCOUNT_PRIVATE_KEY, nonce, confirmationKeyBytes).signature.slice(
                2
            ),
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

        // Another request for the same subject gets its own id and cannot invalidate this one.
        const secondChallenge = (await (
            await fetch(`${base}/v1/challenge`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ subjectNetworkId: SUBJECT_ID })
            })
        ).json()) as { challengeId: string }
        assert.notEqual(secondChallenge.challengeId, challengeId)

        // A bad proof is opaque and leaves the valid challenge available for the retry below.
        const invalidIssue = await fetch(`${base}/v1/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                ...(JSON.parse(issueBody) as object),
                devicePopSignature: "00"
            })
        })
        assert.equal(invalidIssue.status, 400)
        assert.deepEqual(await invalidIssue.json(), { error: "issuance refused", code: "ISSUANCE_REFUSED" })

        const issueRes = await fetch(`${base}/v1/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: issueBody
        })
        assert.equal(issueRes.status, 201, JSON.stringify(await issueRes.clone().json()))
        const issued = (await issueRes.json()) as { id: string; credential: SerializedZkCredential }
        const credential = parseZkCredential(issued.credential)
        assert.equal(verifyZkCredential(credential), true)
        assert.equal(credential.body.revocationCommitment, commitment)

        const replay = await fetch(`${base}/v1/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: issueBody
        })
        assert.equal(replay.status, 400)
        assert.deepEqual(await replay.json(), { error: "issuance refused", code: "ISSUANCE_REFUSED" })

        const record = (await (await fetch(`${base}/v1/credentials/${issued.id}`)).json()) as {
            revoked: boolean
        }
        assert.equal(record.revoked, false)

        const seededRevocation = deriveRevocationCommitment(hexToBytes("11".repeat(32)))
        const revocations = new RevocationRegistry([seededRevocation])
        deployedRevocations = await deployRevocationRegistry(seededRevocation)
        const request = {
            challenge: hexToBytes("0c".repeat(31)),
            audience: `urn:cn:network:${"dd".repeat(32)}`,
            currentTime: credential.body.notBefore,
            programme: "demo-programme",
            country: "ZZZ"
        }
        const wallet = {
            identitySeed: hexToBytes(holder.seed.slice(2)),
            revocationSecret: r,
            deviceSigner
        }
        const otherApprovedIssuer = new LocalCredentialSigner("issuer-service-other-approved")
        const approvedIssuers = new ApprovedIssuerSet([
            await otherApprovedIssuer.getPublicKey(),
            await signer.getPublicKey()
        ])
        const inputs = await buildZkPresentationInputs(
            issued.credential,
            wallet,
            { approvedIssuers, revocations },
            request
        )
        const proofSystem = await ZkCredentialProofSystem.create(CIRCUIT, { backend: { threads: 1 } })
        try {
            const proof = await proofSystem.generateProof(inputs)
            const expected = {
                currentTime: request.currentTime,
                challenge: request.challenge,
                audience: request.audience,
                programme: request.programme,
                country: request.country
            }
            const verification = await proofSystem.verifyProof(proof, expected)
            assert.equal(verification.ok, true)
            if (!verification.ok) throw new Error("proof verification failed")
            assert.equal(verification.approvedIssuerRoot, approvedIssuers.root)
            assert.equal(verification.revocationRoot, revocations.root)
            assert.equal(
                await deployedRevocations.publicClient.readContract({
                    address: deployedRevocations.address,
                    abi: deployedRevocations.abi,
                    functionName: "isValidRoot",
                    args: [TRUSTED_REGISTRY_ID, verification.revocationRoot + 1n]
                }),
                false
            )
            assert.equal(
                await deployedRevocations.publicClient.readContract({
                    address: deployedRevocations.address,
                    abi: deployedRevocations.abi,
                    functionName: "isValidRoot",
                    args: [TRUSTED_REGISTRY_ID, verification.revocationRoot]
                }),
                true
            )

            for (const [publicInput, patch] of [
                ["current_time", { currentTime: 1 }],
                ["challenge", { challenge: hexToBytes("01".repeat(31)) }],
                ["audience", { audience: "urn:cn:network:wrong-verifier" }],
                ["required_programme_hash", { programme: "wrong-programme" }],
                ["required_country_code", { country: "ZZY" }]
            ] as const) {
                assert.deepEqual(await proofSystem.verifyProof(proof, { ...expected, ...patch }), {
                    ok: false,
                    code: "PUBLIC_INPUT_MISMATCH",
                    publicInput
                })
            }

            const tamperedProof = Uint8Array.from(proof.proof)
            tamperedProof[0] ^= 1
            assert.deepEqual(await proofSystem.verifyProof({ ...proof, proof: tamperedProof }, expected), {
                ok: false,
                code: "PROOF_INVALID"
            })
        } finally {
            await proofSystem.destroy()
        }

        assert.equal((await fetch(`${base}/v1/credentials/${issued.id}/revoke`, { method: "POST" })).status, 200)
        const revoked = (await (await fetch(`${base}/v1/credentials/${issued.id}`)).json()) as { revoked: boolean }
        assert.equal(revoked.revoked, true)
        await assert.rejects(
            buildZkPresentationInputs(
                issued.credential,
                wallet,
                { approvedIssuers, revocations: new RevocationRegistry([commitment]) },
                request
            ),
            /revoked/
        )
    } finally {
        deployedRevocations?.anvil.kill()
        listener.close()
    }
})

test("rejects a subjectNetworkId that does not match the account key", async () => {
    const signer = new LocalCredentialSigner("issuer-service-mismatch")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver, minDeviceSecurityLevel: "SOFTWARE" })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`
    const bogus = `0x${"cc".repeat(32)}`

    try {
        const challengeRes = await fetch(`${base}/v1/challenge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subjectNetworkId: bogus })
        })
        const { challengeId, nonce: nonceHex } = (await challengeRes.json()) as {
            challengeId: string
            nonce: string
        }
        const nonce = hexToBytes(nonceHex)
        const deviceSigner = new LocalP256Signer(DEVICE_PRIVATE_KEY)
        const confirmationKey = await deviceSigner.getPublicKeyJwk()
        const confirmationKeyBytes = jwkToPublicKeyBytes(confirmationKey)
        const holder = deriveEddsaKeypair(p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33))
        const r = generateRevocationSecret()
        const ownership = signCommitmentOwnership(r, nonce)
        const holderOwnership = signHolderKeyOwnership(hexToBytes(holder.seed.slice(2)), nonce)

        const res = await fetch(`${base}/v1/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
                challengeId,
                subjectNetworkId: bogus,
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
                    commitment: deriveRevocationCommitment(r).toString(),
                    publicKey: ownership.publicKey.map(String),
                    ownershipSignature: { R8: ownership.signature.R8.map(String), S: ownership.signature.S.toString() }
                }
            })
        })
        assert.equal(res.status, 400)
        assert.equal(((await res.json()) as { code: string }).code, "ISSUANCE_REFUSED")
    } finally {
        listener.close()
    }
})
