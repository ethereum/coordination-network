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
import { onboard, register } from "@coordination-network/user-client"
import type {
    ChainDomain,
    Hex,
    RegistrationRequest,
    RegistrationSubmitter,
    SubmissionReceipt
} from "@coordination-network/user-client"
import { loadConfig } from "../src/config"
import { buildDeliveryPorts } from "../src/delivery-ports"
import { buildRegistrationPorts } from "../src/registration-ports"
import { buildServer } from "../src/server"
import { addMember, deployRegistry, loadArtifact, startAnvil } from "./chain"

const PORT = 18971
const ISSUER_ID = `0x${"ee".repeat(32)}` as Hex32
// anvil's first default funded account: group admin, registration writer, and delivery submitter.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const MEMBER_IDENTITY_SECRET = "77".repeat(32)
const MEMBER_SERVER_TOKEN = "a-member-server-token-long-enough"
const bearer = { authorization: `Bearer ${MEMBER_SERVER_TOKEN}` }

const DEVICE_SECRET_REGISTERED: Hex = `0x${"aa".repeat(32)}`
const DEVICE_SECRET_UNREGISTERED: Hex = `0x${"cc".repeat(32)}`

/** Hands a request to `/v1/registrations`, as a real network member's server would receive it. */
class HttpRegistrationSubmitter implements RegistrationSubmitter {
    constructor(private readonly base: string) {}

    async submit(request: RegistrationRequest): Promise<SubmissionReceipt> {
        const res = await fetch(`${this.base}/v1/registrations`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: JSON.stringify(request)
        })
        if (res.status !== 201) throw new Error(`registration submission failed with status ${res.status}`)
        const body = (await res.json()) as { txHash: Hex }
        return { txHash: body.txHash }
    }
}

describe(`POST /v1/deliveries (anvil, port ${PORT})`, () => {
    let anvil: ChildProcess
    let curve: Curve
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let base: string
    let close: () => void
    let announcerAddress: Address
    let reader: IdentityReader

    before(async () => {
        curve = await getCurveFromName("bn128")
        anvil = await startAnvil(PORT)
        const rpcUrl = `http://127.0.0.1:${PORT}`
        publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ANVIL_KEY),
            chain: foundry,
            transport: http(rpcUrl),
            pollingInterval: 50
        })

        const deployment = await deployRegistry(wallet, publicClient, wallet.account.address)
        const domain: ChainDomain = { chainId: foundry.id, verifyingContract: deployment.registry }

        const memberIdentity = new Identity(hexToBytes(MEMBER_IDENTITY_SECRET))
        await addMember(
            wallet,
            publicClient,
            deployment.semaphore,
            deployment.semaphoreAbi,
            deployment.groupId,
            memberIdentity.commitment
        )

        const announcerArtifact = loadArtifact("ERC5564Announcer")
        const announcerHash = await wallet.deployContract({
            abi: announcerArtifact.abi,
            bytecode: announcerArtifact.bytecode,
            chain: foundry,
            account: wallet.account
        })
        const announcerReceipt = await publicClient.waitForTransactionReceipt({ hash: announcerHash })
        if (!announcerReceipt.contractAddress) throw new Error("ERC5564Announcer deployment failed")
        announcerAddress = announcerReceipt.contractAddress

        const config = loadConfig({
            MEMBER_SERVER_TOKEN,
            ISSUER_NETWORK_ID: ISSUER_ID,
            RPC_URL: rpcUrl,
            IDENTITY_REGISTRY_ADDRESS: deployment.registry,
            CHAIN_ID: String(foundry.id),
            MEMBER_IDENTITY_SECRET,
            SUBMITTER_PRIVATE_KEY: ANVIL_KEY.slice(2),
            ALLOW_DIRECT_REGISTRATION: "true",
            ANNOUNCER_ADDRESS: announcerAddress,
            MEMBER_PRIVATE_KEY: ANVIL_KEY.slice(2),
            ALLOW_DIRECT_DELIVERY: "true",
            ALLOW_IN_MEMORY_REVOCATION: "true"
        })
        if (!config.registration || !config.delivery) throw new Error("expected loadConfig to populate both groups")
        const { submitterPrivateKey } = config.registration
        assert.equal(submitterPrivateKey, `0x${ANVIL_KEY.slice(2)}`)
        const registration = await buildRegistrationPorts({ ...config.registration, submitterPrivateKey }, rpcUrl)
        reader = registration.identityReader

        const signer = new LocalCredentialSigner("issuer-service-deliveries-e2e")
        const resolver = new InMemoryResolver()
        resolver.approveMember(ISSUER_ID)
        const { memberPrivateKey } = config.delivery
        assert.equal(memberPrivateKey, `0x${ANVIL_KEY.slice(2)}`)
        const delivery = await buildDeliveryPorts({ ...config.delivery, memberPrivateKey }, rpcUrl, resolver)
        const app = buildServer({
            issuerNetworkId: ISSUER_ID,
            signer,
            resolver,
            registration,
            delivery,
            memberServerToken: MEMBER_SERVER_TOKEN
        })
        const listener = app.listen(0)
        const { port } = listener.address() as { port: number }
        base = `http://127.0.0.1:${port}`
        close = () => listener.close()

        // Register one recipient through the same registration route deliveries will read back.
        const submitter = new HttpRegistrationSubmitter(base)
        const registered = await register({
            deviceSecret: DEVICE_SECRET_REGISTERED,
            registry: reader,
            submitter,
            domain
        })
        assert.equal(registered.status, "registered")
    })

    after(async () => {
        close?.()
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
        // snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
        await curve.terminate()
    })

    test("delivers to a registered recipient and emits an Announcement log", async () => {
        const { networkId } = onboard(DEVICE_SECRET_REGISTERED)

        const res = await fetch(`${base}/v1/deliveries`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: JSON.stringify({ networkId })
        })
        assert.equal(res.status, 201, JSON.stringify(await res.clone().json()))
        const body = (await res.json()) as { status: string; txHash: Hex }
        assert.deepEqual(Object.keys(body).sort(), ["status", "txHash"])
        assert.equal(body.status, "announced")

        const receipt = await publicClient.waitForTransactionReceipt({ hash: body.txHash })
        assert.equal(receipt.status, "success")
        assert.equal(
            receipt.logs.some((log) => log.address.toLowerCase() === announcerAddress.toLowerCase()),
            true
        )
    })

    test("422s for a recipient with no registered identity", async () => {
        const { networkId } = onboard(DEVICE_SECRET_UNREGISTERED)

        const res = await fetch(`${base}/v1/deliveries`, {
            method: "POST",
            headers: { "content-type": "application/json", ...bearer },
            body: JSON.stringify({ networkId })
        })
        assert.equal(res.status, 422)
        assert.deepEqual(await res.json(), { error: "delivery refused", code: "DELIVERY_REFUSED" })
    })

    test("503s as NOT_CONFIGURED when the server has no delivery ports", async () => {
        const signer = new LocalCredentialSigner("issuer-service-deliveries-unconfigured")
        const resolver = new InMemoryResolver()
        resolver.approveMember(ISSUER_ID)
        const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver })
        const listener = app.listen(0)
        const { port } = listener.address() as { port: number }

        try {
            const res = await fetch(`http://127.0.0.1:${port}/v1/deliveries`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ networkId: onboard(DEVICE_SECRET_REGISTERED).networkId })
            })
            assert.equal(res.status, 503)
            assert.deepEqual(await res.json(), { error: "deliveries not configured", code: "NOT_CONFIGURED" })
        } finally {
            listener.close()
        }
    })
})
