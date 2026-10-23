import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { after, before, describe, test } from "node:test"
import { getCurveFromName, type Curve } from "ffjavascript"
import {
    Account,
    Address,
    Chain,
    PublicClient,
    Transport,
    WalletClient,
    createPublicClient,
    createWalletClient,
    http
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { hexToBytes } from "@noble/hashes/utils"
import { Identity } from "@semaphore-protocol/identity"
import { Hex32, InMemoryResolver, LocalCredentialSigner } from "@coordination-network/credential"
import type { IdentityReader } from "@coordination-network/network-member-client"
import { buildRegistrationRequest, onboard, register } from "@coordination-network/user-client"
import type {
    ChainDomain,
    Hex,
    RegistrationRequest,
    RegistrationSubmitter,
    SubmissionReceipt
} from "@coordination-network/user-client"
import { SubmissionFailedError } from "@coordination-network/user-client"
import { ActivityLog } from "../src/activity"
import { loadConfig } from "../src/config"
import { buildRegistrationPorts } from "../src/registration-ports"
import { buildServer } from "../src/server"
import { addMember, deployRegistry, startAnvil } from "./chain"

const PORT = 18966
const ISSUER_ID = `0x${"bb".repeat(32)}` as Hex32
// anvil's first default funded account: both the group admin and the registration-writer submitter.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const MEMBER_IDENTITY_SECRET = "44".repeat(32)
const MEMBER_SERVER_TOKEN = "a-member-server-token-long-enough"
const bearer = { authorization: `Bearer ${MEMBER_SERVER_TOKEN}` }

const DEVICE_SECRET_A: Hex = `0x${"33".repeat(32)}`
const DEVICE_SECRET_B: Hex = `0x${"55".repeat(32)}`
const DEVICE_SECRET_C: Hex = `0x${"66".repeat(32)}`
const OTHER_VERIFYING_CONTRACT: Hex = `0x${"11".repeat(20)}`

const PORT_TWO_ORGS = 18970
const ISSUER_TWO_ORGS_A_ID = `0x${"c1".repeat(32)}` as Hex32
const ISSUER_TWO_ORGS_B_ID = `0x${"c2".repeat(32)}` as Hex32
const MEMBER_IDENTITY_SECRET_TWO_ORGS_A = "77".repeat(32)
const MEMBER_IDENTITY_SECRET_TWO_ORGS_B = "88".repeat(32)
const DEVICE_SECRET_TWO_ORGS: Hex = `0x${"99".repeat(32)}`

/** Hands a request to `/v1/registrations`, as a real network member's server would receive it. */
class HttpRegistrationSubmitter implements RegistrationSubmitter {
    constructor(private readonly base: string) {}

    async submit(request: RegistrationRequest): Promise<SubmissionReceipt> {
        const res = await fetch(`${this.base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: JSON.stringify(request)
        })
        if (res.status !== 201) {
            throw new SubmissionFailedError(`registration submission failed with status ${res.status}`)
        }
        const body = (await res.json()) as { txHash: Hex }
        return { txHash: body.txHash }
    }
}

/** XORs the low bit of byte 0 of `r`, so the corrupted signature reaches key recovery and fails on
 *  signer mismatch, instead of failing the earlier, shallower v-byte range check. */
function flipSignatureRByte(signature: Hex): Hex {
    const body = signature.slice(2)
    const firstByte = (parseInt(body.slice(0, 2), 16) ^ 1).toString(16).padStart(2, "0")
    return `0x${firstByte}${body.slice(2)}` as Hex
}

describe(`POST /v1/registrations (anvil, port ${PORT})`, () => {
    let anvil: ChildProcess
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let base: string
    let close: () => void
    let rpcUrl: string
    let registryAddress: Address
    let domain: ChainDomain
    let reader: IdentityReader

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

        const deployment = await deployRegistry(wallet, publicClient, wallet.account.address)
        registryAddress = deployment.registry
        domain = { chainId: foundry.id, verifyingContract: registryAddress }

        const memberIdentity = new Identity(hexToBytes(MEMBER_IDENTITY_SECRET))
        await addMember(
            wallet,
            publicClient,
            deployment.semaphore,
            deployment.semaphoreAbi,
            deployment.groupId,
            memberIdentity.commitment
        )

        // Through loadConfig + buildRegistrationPorts, like main.ts, so the config refinement, the
        // chain-id assertion, and the SEMAPHORE()/NETWORK_MEMBER_GROUP_ID() reads all run for real.
        const config = loadConfig({
            MEMBER_SERVER_TOKEN,
            ISSUER_NETWORK_ID: ISSUER_ID,
            RPC_URL: rpcUrl,
            IDENTITY_REGISTRY_ADDRESS: registryAddress,
            CHAIN_ID: String(foundry.id),
            MEMBER_IDENTITY_SECRET,
            SUBMITTER_PRIVATE_KEY: ANVIL_KEY.slice(2),
            ALLOW_DIRECT_REGISTRATION: "true",
            ALLOW_IN_MEMORY_REVOCATION: "true"
        })
        const { registration: registrationConfig } = config
        if (!registrationConfig) throw new Error("expected loadConfig to populate config.registration")
        const { submitterPrivateKey } = registrationConfig
        assert.equal(submitterPrivateKey, `0x${ANVIL_KEY.slice(2)}`)
        const registration = await buildRegistrationPorts({ ...registrationConfig, submitterPrivateKey }, rpcUrl)
        reader = registration.identityReader

        const signer = new LocalCredentialSigner("issuer-service-registrations-e2e")
        const resolver = new InMemoryResolver()
        resolver.approveMember(ISSUER_ID)
        const app = buildServer({
            issuerNetworkId: ISSUER_ID,
            signer,
            resolver,
            registration,
            memberServerToken: MEMBER_SERVER_TOKEN
        })
        const listener = app.listen(0)
        const { port } = listener.address() as { port: number }
        base = `http://127.0.0.1:${port}`
        close = () => listener.close()
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

    test("registers a user through the endpoint and reads the entry back", async () => {
        const submitter = new HttpRegistrationSubmitter(base)
        const { networkId, metaStealthAddress } = onboard(DEVICE_SECRET_A)

        const result = await register({ deviceSecret: DEVICE_SECRET_A, registry: reader, submitter, domain })
        assert.equal(result.status, "registered")
        if (result.status !== "registered") throw new Error("expected registered")
        assert.ok(result.receipt.txHash)

        await publicClient.waitForTransactionReceipt({ hash: result.receipt.txHash })
        assert.equal(await reader.getIdentity(networkId), metaStealthAddress)

        const duplicate = await fetch(`${base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: JSON.stringify(result.request)
        })
        assert.equal(duplicate.status, 200)
        assert.deepEqual(await duplicate.json(), {
            status: "alreadyRegistered",
            metaStealthAddress,
            matchesRequest: true
        })

        const withoutSignature: Partial<RegistrationRequest> = { ...result.request }
        delete withoutSignature.signature
        const malformed = await fetch(`${base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: JSON.stringify(withoutSignature)
        })
        assert.equal(malformed.status, 400)
        assert.deepEqual(await malformed.json(), { error: "malformed registration request" })
    })

    test("rejects a corrupted signature without leaking the networkId or signature", async () => {
        const { keys, networkId } = onboard(DEVICE_SECRET_C)
        const request = buildRegistrationRequest(keys, domain)
        const tampered = { ...request, signature: flipSignatureRByte(request.signature) }

        const res = await fetch(`${base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: JSON.stringify(tampered)
        })
        assert.equal(res.status, 400)
        const body = await res.json()
        assert.equal((body as { code: string }).code, "INVALID_REGISTRATION_REQUEST")
        const text = JSON.stringify(body)
        assert.equal(text.includes(networkId), false)
        assert.equal(text.includes(request.signature), false)
    })

    test("rejects a request signed for a different verifyingContract", async () => {
        const mistargeted = buildRegistrationRequest(onboard(DEVICE_SECRET_B).keys, {
            chainId: foundry.id,
            verifyingContract: OTHER_VERIFYING_CONTRACT
        })
        const res = await fetch(`${base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: JSON.stringify(mistargeted)
        })
        assert.equal(res.status, 400)
        assert.equal(((await res.json()) as { code: string }).code, "INVALID_REGISTRATION_REQUEST")
    })

    test("400s as malformed json for a non-JSON body", async () => {
        const res = await fetch(`${base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: "not json"
        })
        assert.equal(res.status, 400)
        assert.deepEqual(await res.json(), { error: "malformed json" })
    })

    test("401s a registration submitted without the member server token", async () => {
        const res = await fetch(`${base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({})
        })
        assert.equal(res.status, 401)
    })

    test("503s as NOT_CONFIGURED when the server has no registration ports", async () => {
        const signer = new LocalCredentialSigner("issuer-service-registrations-unconfigured")
        const resolver = new InMemoryResolver()
        resolver.approveMember(ISSUER_ID)
        const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver })
        const listener = app.listen(0)
        const { port } = listener.address() as { port: number }

        try {
            const res = await fetch(`http://127.0.0.1:${port}/v1/registrations`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({})
            })
            assert.equal(res.status, 503)
            assert.deepEqual(await res.json(), { error: "registration not configured", code: "NOT_CONFIGURED" })
        } finally {
            listener.close()
        }
    })

    test("loadConfig rejects a partial registration group", () => {
        assert.throws(
            () =>
                loadConfig({
                    RPC_URL: rpcUrl,
                    IDENTITY_REGISTRY_ADDRESS: registryAddress,
                    CHAIN_ID: String(foundry.id)
                    // MEMBER_IDENTITY_SECRET and SUBMITTER_PRIVATE_KEY deliberately omitted.
                }),
            /must all be set together/
        )
    })

    test("buildRegistrationPorts rejects a wrong CHAIN_ID", async () => {
        const config = loadConfig({
            MEMBER_SERVER_TOKEN,
            RPC_URL: rpcUrl,
            IDENTITY_REGISTRY_ADDRESS: registryAddress,
            CHAIN_ID: String(foundry.id + 1),
            MEMBER_IDENTITY_SECRET,
            SUBMITTER_PRIVATE_KEY: ANVIL_KEY.slice(2),
            ALLOW_DIRECT_REGISTRATION: "true",
            ALLOW_IN_MEMORY_REVOCATION: "true"
        })
        const { registration: registrationConfig } = config
        if (!registrationConfig) throw new Error("expected loadConfig to populate config.registration")
        const { submitterPrivateKey } = registrationConfig
        assert.equal(submitterPrivateKey, `0x${ANVIL_KEY.slice(2)}`)
        await assert.rejects(
            () => buildRegistrationPorts({ ...registrationConfig, submitterPrivateKey }, rpcUrl),
            /RPC at .* reports chain/
        )
    })
})

describe(`POST /v1/registrations across two orgs on the same registry (anvil, port ${PORT_TWO_ORGS})`, () => {
    let anvil: ChildProcess
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let domain: ChainDomain
    let orgA: { base: string; close: () => void; activityLog: ActivityLog }
    let orgB: { base: string; close: () => void; activityLog: ActivityLog }

    before(async () => {
        anvil = await startAnvil(PORT_TWO_ORGS)
        const rpcUrl = `http://127.0.0.1:${PORT_TWO_ORGS}`
        publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ANVIL_KEY),
            chain: foundry,
            transport: http(rpcUrl),
            pollingInterval: 50
        })

        const deployment = await deployRegistry(wallet, publicClient, wallet.account.address)
        domain = { chainId: foundry.id, verifyingContract: deployment.registry }

        // Both orgs' own member identities admitted to the same registration group, the way a
        // single org's is in the suite above: each can independently write to or read this
        // registry once buildRegistrationPorts proves membership with its own secret.
        for (const secret of [MEMBER_IDENTITY_SECRET_TWO_ORGS_A, MEMBER_IDENTITY_SECRET_TWO_ORGS_B]) {
            await addMember(
                wallet,
                publicClient,
                deployment.semaphore,
                deployment.semaphoreAbi,
                deployment.groupId,
                new Identity(hexToBytes(secret)).commitment
            )
        }

        const buildOrg = async (
            issuerNetworkId: Hex32,
            memberIdentitySecret: string
        ): Promise<{ base: string; close: () => void; activityLog: ActivityLog }> => {
            const config = loadConfig({
                MEMBER_SERVER_TOKEN,
                ISSUER_NETWORK_ID: issuerNetworkId,
                RPC_URL: rpcUrl,
                IDENTITY_REGISTRY_ADDRESS: deployment.registry,
                CHAIN_ID: String(foundry.id),
                MEMBER_IDENTITY_SECRET: memberIdentitySecret,
                SUBMITTER_PRIVATE_KEY: ANVIL_KEY.slice(2),
                ALLOW_DIRECT_REGISTRATION: "true",
                ALLOW_IN_MEMORY_REVOCATION: "true"
            })
            const { registration: registrationConfig } = config
            if (!registrationConfig) throw new Error("expected loadConfig to populate config.registration")
            const { submitterPrivateKey } = registrationConfig
            assert.equal(submitterPrivateKey, `0x${ANVIL_KEY.slice(2)}`)
            const registration = await buildRegistrationPorts({ ...registrationConfig, submitterPrivateKey }, rpcUrl)

            const signer = new LocalCredentialSigner(`issuer-service-two-orgs-${issuerNetworkId}`)
            const resolver = new InMemoryResolver()
            resolver.approveMember(issuerNetworkId)
            const activityLog = new ActivityLog()
            const app = buildServer({ issuerNetworkId, signer, resolver, registration, activityLog })
            const listener = app.listen(0)
            const { port } = listener.address() as { port: number }
            return { base: `http://127.0.0.1:${port}`, close: () => listener.close(), activityLog }
        }

        orgA = await buildOrg(ISSUER_TWO_ORGS_A_ID, MEMBER_IDENTITY_SECRET_TWO_ORGS_A)
        orgB = await buildOrg(ISSUER_TWO_ORGS_B_ID, MEMBER_IDENTITY_SECRET_TWO_ORGS_B)
    })

    after(async () => {
        orgA?.close()
        orgB?.close()
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
    })

    test("org B recognizes the person org A just registered, and each org's own activity log says so", async () => {
        const { keys, metaStealthAddress } = onboard(DEVICE_SECRET_TWO_ORGS)
        const request = buildRegistrationRequest(keys, domain)
        const body = JSON.stringify(request)

        const submittedResponse = await fetch(`${orgA.base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body
        })
        assert.equal(submittedResponse.status, 201, JSON.stringify(await submittedResponse.clone().json()))
        const submitted = (await submittedResponse.json()) as { status: string; txHash: Hex }
        assert.equal(submitted.status, "submitted")
        await publicClient.waitForTransactionReceipt({ hash: submitted.txHash })

        const duplicateResponse = await fetch(`${orgB.base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body
        })
        assert.equal(duplicateResponse.status, 200)
        assert.deepEqual(await duplicateResponse.json(), {
            status: "alreadyRegistered",
            metaStealthAddress,
            matchesRequest: true
        })

        assert.deepEqual(
            orgA.activityLog.recent().map((entry) => entry.outcome),
            ["ok"]
        )
        assert.deepEqual(
            orgB.activityLog.recent().map((entry) => entry.outcome),
            ["existing"]
        )
    })
})

// A sponsored write proves Semaphore group membership, which keeps snarkjs's bn128 curve worker
// pool alive; without this the run never exits (see e2e.test.ts and verify-two-orgs.e2e.test.ts).
let curve: Curve

before(async () => {
    curve = await getCurveFromName("bn128")
})

after(async () => {
    await curve.terminate()
})
