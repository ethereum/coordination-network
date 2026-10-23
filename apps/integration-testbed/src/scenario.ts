import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { Server as HttpServer } from "node:http"
import { p256 } from "@noble/curves/nist.js"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { testActions } from "viem"
import {
    buildDeviceBindingMessage,
    deriveKeys,
    deriveEddsaKeypair,
    eddsaPeerPointBytes,
    EddsaKeypair,
    Secp256k1Keypair,
    signAccountBinding
} from "@coordination-network/identity"
import {
    ApprovedIssuerSet,
    buildZkPresentationInputs,
    deriveRevocationCommitment,
    generateRevocationSecret,
    Hex32,
    issuanceRequestCommitment,
    Jwk,
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
import { rebuildMirror } from "../../issuer-service/src/revocation"
import { buildServer } from "../../issuer-service/src/server"
import { freePort } from "./anvil"
import { Identity } from "@coordination-network/account"
import { CREDENTIAL_CIRCUIT_PATH } from "./config"
import { RevocationDeployment } from "./deployer"
import { peerIssuerSigningSeeds, personas, type UserSecrets } from "./personas"
import { createRevocationResolver } from "./revocation-resolver"

type CredentialScenarioOptions = {
    alice?: UserSecrets
    beforeRevocation?: (isCredentialActive: () => Promise<boolean>) => Promise<void>
    afterRevocation?: (isCredentialActive: () => Promise<boolean>) => Promise<void>
}

type HolderKeys = {
    networkId: Hex32
    account: Secp256k1Keypair
    deviceSigner: LocalP256Signer
    confirmationKey: Jwk
    identityKey: EddsaKeypair
    revocationSecret: Uint8Array
}

type IssuedCredential = { id: string; credential: SerializedZkCredential }

async function listen(server: ReturnType<typeof buildServer>, port: number): Promise<HttpServer> {
    return new Promise((resolve, reject) => {
        const listener = server.listen(port, "127.0.0.1", () => resolve(listener))
        listener.once("error", reject)
    })
}

async function closeServer(server: HttpServer | undefined): Promise<void> {
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function generateProofWithoutBackendLog<T>(generate: () => Promise<T>): Promise<T> {
    // bb.js prints an unstructured success line. Suppress only that line so the
    // testbed can report the same proof metadata in its timeline.
    // eslint-disable-next-line no-console
    const originalLog = console.log
    // eslint-disable-next-line no-console
    console.log = (...args: unknown[]) => {
        if (typeof args[0] === "string" && args[0].startsWith("Generated proof for circuit")) return
        originalLog(...args)
    }
    try {
        return await generate()
    } finally {
        // eslint-disable-next-line no-console
        console.log = originalLog
    }
}

async function deriveHolderKeys(secrets: UserSecrets): Promise<HolderKeys> {
    const keys = deriveKeys(secrets.deviceSecret)
    const deviceSigner = new LocalP256Signer(secrets.devicePrivateKey)
    return {
        networkId: keys.networkId,
        account: keys.account,
        deviceSigner,
        confirmationKey: await deviceSigner.getPublicKeyJwk(),
        identityKey: deriveEddsaKeypair(
            p256.getSharedSecret(secrets.devicePrivateKey, eddsaPeerPointBytes()).slice(1, 33)
        ),
        revocationSecret: secrets.revocationSecret
    }
}

async function requestCredential(
    issuerUrl: string,
    issuerNetworkId: Hex32,
    holder: HolderKeys
): Promise<IssuedCredential> {
    const approvalScope = { programme: "demo-programme", country: "ZZZ" }
    const challengeResponse = await fetch(`${issuerUrl}/v1/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectNetworkId: holder.networkId })
    })
    assert.equal(challengeResponse.status, 200)
    const { challengeId, nonce: nonceHex } = (await challengeResponse.json()) as {
        challengeId: string
        nonce: string
    }
    const nonce = hexToBytes(nonceHex)
    const ownership = signCommitmentOwnership(holder.revocationSecret, nonce)
    const holderOwnership = signHolderKeyOwnership(hexToBytes(holder.identityKey.seed.slice(2)), nonce)

    const issueResponse = await fetch(`${issuerUrl}/v1/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            challengeId,
            subjectNetworkId: holder.networkId,
            approvalScope,
            confirmationKey: holder.confirmationKey,
            accountPublicKey: holder.account.publicKey.slice(2),
            devicePopSignature: bytesToHex(
                await holder.deviceSigner.sign(
                    buildDeviceBindingMessage(
                        nonce,
                        holder.networkId,
                        hexToBytes(holder.identityKey.commitment.toString(16).padStart(64, "0")),
                        issuanceRequestCommitment(issuerNetworkId, approvalScope)
                    )
                )
            ),
            accountPopSignature: signAccountBinding(
                holder.account.privateKey,
                nonce,
                jwkToPublicKeyBytes(holder.confirmationKey)
            ).signature.slice(2),
            identityPublicKey: holder.identityKey.publicKey.map(String),
            identityOwnershipSignature: {
                R8: holderOwnership.signature.R8.map(String),
                S: holderOwnership.signature.S.toString()
            },
            revocation: {
                commitment: deriveRevocationCommitment(holder.revocationSecret).toString(),
                publicKey: ownership.publicKey.map(String),
                ownershipSignature: {
                    R8: ownership.signature.R8.map(String),
                    S: ownership.signature.S.toString()
                }
            }
        })
    })
    assert.equal(issueResponse.status, 201, await issueResponse.clone().text())
    return (await issueResponse.json()) as IssuedCredential
}

export async function runCredentialScenario(
    deployment: RevocationDeployment,
    memberIdentity: Identity,
    issuerNetworkId: Hex32,
    diagnostic: (message: string) => void = () => {},
    options: CredentialScenarioOptions = {}
): Promise<void> {
    let issuerServer: HttpServer | undefined
    let eveServer: HttpServer | undefined

    try {
        const revocations = await rebuildMirror(
            deployment.chain.publicClient,
            deployment.revocationAddress,
            deployment.registryId
        )
        diagnostic(`Revocation tree rebuilt from the chain at root ${revocations.root}`)

        const signer = new LocalCredentialSigner(personas.networkMember.credentialSigningSeed)
        const peerSigners = peerIssuerSigningSeeds.map((seed) => new LocalCredentialSigner(seed))
        const approvedIssuers = new ApprovedIssuerSet(
            await Promise.all([...peerSigners, signer].map((issuer) => issuer.getPublicKey()))
        )
        diagnostic(
            `Approved issuer set has ${approvedIssuers.size} network members; root 0x${approvedIssuers.root.toString(16)}`
        )
        const resolver = createRevocationResolver(deployment, memberIdentity, issuerNetworkId, revocations)
        const issuerPort = await freePort()
        issuerServer = await listen(
            buildServer({
                issuerNetworkId,
                signer,
                resolver,
                minDeviceSecurityLevel: "SOFTWARE",
                // This focused credential scenario does not run the registration flow. Supply
                // explicit test eligibility instead of relying on buildServer's fail-closed defaults.
                identityReader: { getIdentity: async () => "0x1234" },
                issuancePolicy: {
                    decideIssuance: async () => ({ programme: "demo-programme", country: "ZZZ" })
                }
            }),
            issuerPort
        )
        const issuerUrl = `http://127.0.0.1:${issuerPort}`
        diagnostic(`Issuer service ${issuerUrl}`)

        const holder = await deriveHolderKeys({
            ...(options.alice ?? personas.alice),
            revocationSecret: generateRevocationSecret()
        })
        const aliceCommitment = deriveRevocationCommitment(holder.revocationSecret)

        const issued = await requestCredential(issuerUrl, issuerNetworkId, holder)
        const credential = parseZkCredential(issued.credential)
        assert.equal(verifyZkCredential(credential), true)
        diagnostic(`Issued and signature-verified credential ${issued.id}`)

        const request = {
            challenge: hexToBytes("0c".repeat(31)),
            audience: personas.bob.audience,
            currentTime: credential.body.notBefore,
            programme: "demo-programme",
            country: "ZZZ"
        }
        const wallet = {
            identitySeed: hexToBytes(holder.identityKey.seed.slice(2)),
            revocationSecret: holder.revocationSecret,
            deviceSigner: holder.deviceSigner
        }
        diagnostic(
            `${personas.bob.name} requests ${request.programme}/${request.country} proof from ${personas.alice.name}`
        )
        const inputs = await buildZkPresentationInputs(
            issued.credential,
            wallet,
            { approvedIssuers, revocations },
            request
        )
        const circuit = JSON.parse(readFileSync(CREDENTIAL_CIRCUIT_PATH, "utf8")) as ZkCredentialCircuit
        const proofSystem = await ZkCredentialProofSystem.create(circuit, { backend: { threads: 1 } })
        try {
            const proof = await generateProofWithoutBackendLog(() => proofSystem.generateProof(inputs))
            diagnostic(
                `Generated presentation proof with ${proof.publicInputs.length} public inputs and ${proof.proof.length / 32} proof fields`
            )
            diagnostic(
                `Alice proved her issuer is one of ${approvedIssuers.size} approved members without revealing which`
            )
            const verification = await proofSystem.verifyProof(proof, request)
            assert.equal(verification.ok, true)
            if (!verification.ok) throw new Error("presentation proof verification failed")
            assert.equal(
                await deployment.chain.publicClient.readContract({
                    address: deployment.address,
                    abi: deployment.abi,
                    functionName: "isValidRoot",
                    args: [verification.revocationRoot]
                }),
                true
            )
            assert.equal(verification.approvedIssuerRoot, approvedIssuers.root)
            diagnostic(
                `Issuer root matches the approved set; the signing member is one of ${approvedIssuers.size} and is not identified`
            )
            diagnostic(`${personas.bob.name} accepted Alice's verified presentation`)

            const isCredentialActive = async () =>
                (await deployment.chain.publicClient.readContract({
                    address: deployment.address,
                    abi: deployment.abi,
                    functionName: "isValidRoot",
                    args: [verification.revocationRoot]
                })) as boolean

            const eveSigner = new LocalCredentialSigner(personas.eve.credentialSigningSeed)
            const evePort = await freePort()
            eveServer = await listen(
                buildServer({
                    issuerNetworkId: personas.eve.networkId,
                    signer: eveSigner,
                    resolver,
                    minDeviceSecurityLevel: "SOFTWARE",
                    // An unapproved member runs its own issuer and approves itself.
                    approval: { isApprovedNetworkMember: async () => true },
                    identityReader: { getIdentity: async () => "0x1234" },
                    issuancePolicy: {
                        decideIssuance: async () => ({ programme: "demo-programme", country: "ZZZ" })
                    }
                }),
                evePort
            )
            const eve = await requestCredential(`http://127.0.0.1:${evePort}`, personas.eve.networkId, holder)
            const eveCredential = parseZkCredential(eve.credential)
            assert.equal(verifyZkCredential(eveCredential), true)
            diagnostic("Eve issued Alice a credential outside the approved set")

            await assert.rejects(
                buildZkPresentationInputs(eve.credential, wallet, { approvedIssuers, revocations }, request),
                /not in the approved set/
            )
            diagnostic("Alice's wallet cannot present Eve's credential against the approved set")
            const eveSet = new ApprovedIssuerSet([await eveSigner.getPublicKey()])
            // The circuit asserts not_before <= current_time and Eve's credential is stamped later than Alice's.
            const eveRequest = { ...request, currentTime: eveCredential.body.notBefore }
            const eveInputs = await buildZkPresentationInputs(
                eve.credential,
                wallet,
                { approvedIssuers: eveSet, revocations },
                eveRequest
            )
            const eveProof = await generateProofWithoutBackendLog(() => proofSystem.generateProof(eveInputs))
            diagnostic(
                `Alice's wallet generated a proof against Eve's look-alike network; issuer root 0x${eveSet.root.toString(16)}`
            )

            const eveVerification = await proofSystem.verifyProof(eveProof, eveRequest)
            assert.equal(eveVerification.ok, true)
            if (!eveVerification.ok) throw new Error("look-alike presentation proof verification failed")
            assert.equal(eveVerification.approvedIssuerRoot, eveSet.root)
            assert.notEqual(eveVerification.approvedIssuerRoot, approvedIssuers.root)
            diagnostic(
                `${personas.bob.name} rejected Eve's presentation; issuer root 0x${eveSet.root.toString(16)} is not the approved root 0x${approvedIssuers.root.toString(16)}`
            )

            await options.beforeRevocation?.(isCredentialActive)

            const revokeResponse = await fetch(`${issuerUrl}/v1/credentials/${issued.id}/revoke`, { method: "POST" })
            assert.equal(revokeResponse.status, 200, await revokeResponse.clone().text())
            assert.equal(await resolver.isRevoked(aliceCommitment), true)
            const { publicClient } = deployment.chain
            const revocationRootAfterRevoke = await publicClient.readContract({
                address: deployment.address,
                abi: deployment.abi,
                functionName: "getRevocationRoot"
            })
            assert.notEqual(revocationRootAfterRevoke, verification.revocationRoot)
            assert.equal(revocationRootAfterRevoke, revocations.root)

            // Fast forward time on local node to assert root is correct after expiry window
            if ((await publicClient.request({ method: "web3_clientVersion" })).startsWith("anvil")) {
                const rootDuration = (await publicClient.readContract({
                    address: deployment.revocationAddress,
                    abi: deployment.revocationAbi,
                    functionName: "getRegistryRootDuration",
                    args: [deployment.registryId]
                })) as bigint
                const anvil = publicClient.extend(testActions({ mode: "anvil" }))
                await anvil.increaseTime({ seconds: Number(rootDuration) + 1 })
                await anvil.mine({ blocks: 1 })
                assert.equal(await isCredentialActive(), false)
            }
            await assert.rejects(
                buildZkPresentationInputs(issued.credential, wallet, { approvedIssuers, revocations }, request),
                /revoked/
            )
            diagnostic(`Published revocation commitment ${aliceCommitment}`)
            diagnostic(`${personas.bob.name} rejected Alice's revoked credential`)
            await options.afterRevocation?.(isCredentialActive)
        } finally {
            await proofSystem.destroy()
        }
    } finally {
        await closeServer(eveServer)
        await closeServer(issuerServer)
    }
}
