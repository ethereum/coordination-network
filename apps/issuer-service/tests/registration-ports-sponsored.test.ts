import assert from "node:assert/strict"
import { ChildProcess } from "node:child_process"
import { createServer } from "node:http"
import type { Server } from "node:http"
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
    getAddress,
    http,
    numberToHex,
    parseEther
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { onboard } from "@coordination-network/user-client"
import type { Hex } from "@coordination-network/user-client"
import type { SponsoredRegistrationConfig } from "../src/registration-ports"
import { buildSponsoredRegistrationPorts } from "../src/registration-ports"
import { loadConfig } from "../src/config"
import { deployRegistry, loadArtifact, startAnvil } from "./chain"

const PORT = 18977
const RPC_URL = `http://127.0.0.1:${PORT}`
// anvil's first default funded account
const ADMIN_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const MEMBER_IDENTITY_SECRET = "44".repeat(32)
const MEMBER_SECRET: Hex = `0x${MEMBER_IDENTITY_SECRET}`

type Wallet = WalletClient<Transport, Chain, Account>

/** Links SemaphorePaymaster's PoseidonT3 placeholder, mirroring `chain.ts`'s own private helper. */
function linkPoseidon(
    bytecode: Hex,
    linkReferences: Record<string, Record<string, { start: number; length: number }[]>>,
    poseidon: Address
): Hex {
    let linked = bytecode
    for (const fileReferences of Object.values(linkReferences)) {
        for (const references of Object.values(fileReferences)) {
            const address = poseidon.slice(2).toLowerCase()
            for (const { start, length } of references) {
                const from = 2 + start * 2
                const to = from + length * 2
                linked = (linked.slice(0, from) + address + linked.slice(to)) as Hex
            }
        }
    }
    return linked
}

/**
 * A real, but otherwise unused, SemaphorePaymaster: `BasePaymaster`'s constructor calls
 * `supportsInterface` on the EntryPoint address it's given, so it must be a real IEntryPoint, not
 * a placeholder — a plain deploy (any address CREATE assigns) satisfies that without needing the
 * canonical v0.8 address or EIP-7702 (this suite only checks `buildSponsoredRegistrationPorts`'s
 * own wiring, not a sponsored send; that path is covered on a real EntryPoint in
 * network-member-client's anvil integration suite).
 */
async function deployPaymaster(
    wallet: Wallet,
    publicClient: PublicClient,
    admin: Address
): Promise<{ address: Address; entryPoint: Address; groupId: bigint }> {
    const entryPointArtifact = loadArtifact("EntryPoint")
    const entryPointHash = await wallet.deployContract({
        abi: entryPointArtifact.abi,
        bytecode: entryPointArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const entryPointReceipt = await publicClient.waitForTransactionReceipt({ hash: entryPointHash })
    if (!entryPointReceipt.contractAddress) throw new Error("EntryPoint deployment failed")

    const verifierArtifact = loadArtifact("SemaphoreVerifier")
    const verifierHash = await wallet.deployContract({
        abi: verifierArtifact.abi,
        bytecode: verifierArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const verifierReceipt = await publicClient.waitForTransactionReceipt({ hash: verifierHash })
    if (!verifierReceipt.contractAddress) throw new Error("SemaphoreVerifier deployment failed")

    const poseidonArtifact = loadArtifact("PoseidonT3")
    const poseidonHash = await wallet.deployContract({
        abi: poseidonArtifact.abi,
        bytecode: poseidonArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const poseidonReceipt = await publicClient.waitForTransactionReceipt({ hash: poseidonHash })
    if (!poseidonReceipt.contractAddress) throw new Error("PoseidonT3 deployment failed")

    const paymasterArtifact = loadArtifact("SemaphorePaymaster")
    const paymasterHash = await wallet.deployContract({
        abi: paymasterArtifact.abi,
        bytecode: linkPoseidon(
            paymasterArtifact.bytecode,
            paymasterArtifact.linkReferences,
            poseidonReceipt.contractAddress
        ),
        args: [entryPointReceipt.contractAddress, verifierReceipt.contractAddress, admin, parseEther("0.05")],
        chain: foundry,
        account: wallet.account
    })
    const paymasterReceipt = await publicClient.waitForTransactionReceipt({ hash: paymasterHash })
    if (!paymasterReceipt.contractAddress) throw new Error("SemaphorePaymaster deployment failed")

    const groupId = (await publicClient.readContract({
        address: paymasterReceipt.contractAddress,
        abi: paymasterArtifact.abi,
        functionName: "GROUP_ID"
    })) as bigint

    return { address: paymasterReceipt.contractAddress, entryPoint: entryPointReceipt.contractAddress, groupId }
}

async function deployAccountImplementation(wallet: Wallet, publicClient: PublicClient): Promise<Address> {
    const artifact = loadArtifact("Simple7702Account")
    const hash = await wallet.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error("Simple7702Account deployment failed")
    return receipt.contractAddress
}

/**
 * A JSON-RPC endpoint that answers `eth_supportedEntryPoints` and `eth_chainId`, and nothing else.
 * `failing` names a method it answers with a JSON-RPC error instead.
 */
async function startBundlerStub(
    supported: string[],
    chainId: number = foundry.id,
    failing?: string
): Promise<{ server: Server; url: string }> {
    const server = createServer((request, response) => {
        let body = ""
        request.on("data", (chunk) => (body += chunk))
        request.on("end", () => {
            const { id, method }: { id: number; method: string } = JSON.parse(body)
            response.setHeader("content-type", "application/json")
            response.end(
                JSON.stringify(
                    method === failing
                        ? { jsonrpc: "2.0", id, error: { code: -32000, message: "unavailable" } }
                        : { jsonrpc: "2.0", id, result: method === "eth_chainId" ? numberToHex(chainId) : supported }
                )
            )
        })
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    if (address === null || typeof address === "string") throw new Error("bundler stub has no port")
    return { server, url: `http://127.0.0.1:${address.port}` }
}

describe(`buildSponsoredRegistrationPorts (anvil, port ${PORT})`, () => {
    let anvil: ChildProcess
    let curve: Curve
    let publicClient: PublicClient
    let wallet: Wallet
    let baseConfig: SponsoredRegistrationConfig
    let bundlerStub: { server: Server; url: string }
    let emptyBundlerStub: { server: Server; url: string }
    let otherChainBundlerStub: { server: Server; url: string }
    let chainIdFailingBundlerStub: { server: Server; url: string }
    let checksummedBundlerStub: { server: Server; url: string }

    before(async () => {
        curve = await getCurveFromName("bn128")
        anvil = await startAnvil(PORT)
        publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ADMIN_KEY),
            chain: foundry,
            transport: http(RPC_URL),
            pollingInterval: 50
        })

        const registry = await deployRegistry(wallet, publicClient, wallet.account.address)
        const paymaster = await deployPaymaster(wallet, publicClient, wallet.account.address)

        const accountImplementation = await deployAccountImplementation(wallet, publicClient)
        bundlerStub = await startBundlerStub([paymaster.entryPoint])
        emptyBundlerStub = await startBundlerStub([])
        otherChainBundlerStub = await startBundlerStub([paymaster.entryPoint], foundry.id + 1)
        checksummedBundlerStub = await startBundlerStub([getAddress(paymaster.entryPoint)])
        chainIdFailingBundlerStub = await startBundlerStub([paymaster.entryPoint], foundry.id, "eth_chainId")

        baseConfig = {
            identityRegistryAddress: registry.registry,
            chainId: foundry.id,
            memberIdentitySecret: Buffer.from(MEMBER_IDENTITY_SECRET, "hex"),
            memberGroupFromBlock: 0,
            sponsored: {
                memberSecret: MEMBER_SECRET,
                entryPoint: paymaster.entryPoint,
                paymaster: paymaster.address,
                accountImplementation,
                bundlerUrl: bundlerStub.url,
                paymasterGroupFromBlock: 0
            }
        }
    })

    after(async () => {
        bundlerStub?.server.close()
        emptyBundlerStub?.server.close()
        otherChainBundlerStub?.server.close()
        checksummedBundlerStub?.server.close()
        chainIdFailingBundlerStub?.server.close()
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
        // snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
        await curve.terminate()
    })

    test("wires ports against the real registry and paymaster", async () => {
        const ports = await buildSponsoredRegistrationPorts(baseConfig, RPC_URL)

        assert.deepEqual(ports.domain, { chainId: foundry.id, verifyingContract: baseConfig.identityRegistryAddress })
        assert.equal(ports.writer.registry.address.toLowerCase(), baseConfig.identityRegistryAddress.toLowerCase())
        assert.equal(ports.writer.registry.chainId, BigInt(foundry.id))

        const { networkId } = onboard(`0x${"66".repeat(32)}` as Hex)
        assert.equal(await ports.identityReader.getIdentity(networkId), null)
    })

    test("rejects a config pointing at the wrong chain", async () => {
        await assert.rejects(
            () => buildSponsoredRegistrationPorts({ ...baseConfig, chainId: foundry.id + 1 }, RPC_URL),
            /RPC at .* reports chain/
        )
    })

    test("rejects a bundler that does not serve the configured EntryPoint", async () => {
        await assert.rejects(
            () =>
                buildSponsoredRegistrationPorts(
                    { ...baseConfig, sponsored: { ...baseConfig.sponsored, bundlerUrl: emptyBundlerStub.url } },
                    RPC_URL
                ),
            (error: Error) =>
                /does not serve EntryPoint/.test(error.message) && !error.message.includes(emptyBundlerStub.url)
        )
    })

    test("rejects a bundler serving another chain, without its URL", async () => {
        await assert.rejects(
            () =>
                buildSponsoredRegistrationPorts(
                    { ...baseConfig, sponsored: { ...baseConfig.sponsored, bundlerUrl: otherChainBundlerStub.url } },
                    RPC_URL
                ),
            (error: Error) =>
                error.message ===
                    `the bundler serves chain ${foundry.id + 1}, not this deployment's chain ${foundry.id}` &&
                !error.message.includes(otherChainBundlerStub.url)
        )
    })

    test("accepts a bundler that reports the EntryPoint in another case", async () => {
        // Anvil returns lowercase receipt addresses, so the stub's checksummed form differs from the config's.
        assert.notEqual(baseConfig.sponsored.entryPoint, getAddress(baseConfig.sponsored.entryPoint))

        await buildSponsoredRegistrationPorts(
            { ...baseConfig, sponsored: { ...baseConfig.sponsored, bundlerUrl: checksummedBundlerStub.url } },
            RPC_URL
        )
    })

    test("reports a bundler that fails eth_chainId without its URL", async () => {
        await assert.rejects(
            () =>
                buildSponsoredRegistrationPorts(
                    {
                        ...baseConfig,
                        sponsored: { ...baseConfig.sponsored, bundlerUrl: chainIdFailingBundlerStub.url }
                    },
                    RPC_URL
                ),
            (error: Error) =>
                error.message === "BUNDLER_URL did not answer eth_chainId" &&
                !error.message.includes(chainIdFailingBundlerStub.url)
        )
    })

    test("reports an unreachable bundler without its URL", async () => {
        const bundlerUrl = "http://127.0.0.1:1/key-abc123"

        await assert.rejects(
            () =>
                buildSponsoredRegistrationPorts(
                    { ...baseConfig, sponsored: { ...baseConfig.sponsored, bundlerUrl } },
                    RPC_URL
                ),
            (error: Error) => /BUNDLER_URL did not answer/.test(error.message) && !error.message.includes("key-abc123")
        )
    })

    test("rejects an account implementation with no code", async () => {
        await assert.rejects(
            () =>
                buildSponsoredRegistrationPorts(
                    {
                        ...baseConfig,
                        sponsored: { ...baseConfig.sponsored, accountImplementation: `0x${"22".repeat(20)}` }
                    },
                    RPC_URL
                ),
            /no contract at ACCOUNT_IMPLEMENTATION_ADDRESS/
        )
    })

    test("rejects an entry point with no code", async () => {
        await assert.rejects(
            () =>
                buildSponsoredRegistrationPorts(
                    { ...baseConfig, sponsored: { ...baseConfig.sponsored, entryPoint: `0x${"11".repeat(20)}` } },
                    RPC_URL
                ),
            /no contract at ENTRY_POINT_ADDRESS/
        )
    })

    test("takes loadConfig's registration straight", async () => {
        const { sponsored } = baseConfig
        const { registration } = loadConfig({
            RPC_URL,
            MEMBER_SERVER_TOKEN: "a-member-server-token-long-enough",
            ALLOW_IN_MEMORY_REVOCATION: "true",
            IDENTITY_REGISTRY_ADDRESS: baseConfig.identityRegistryAddress,
            CHAIN_ID: String(foundry.id),
            MEMBER_IDENTITY_SECRET,
            ENTRY_POINT_ADDRESS: sponsored.entryPoint,
            PAYMASTER_ADDRESS: sponsored.paymaster,
            ACCOUNT_IMPLEMENTATION_ADDRESS: sponsored.accountImplementation,
            BUNDLER_URL: sponsored.bundlerUrl
        })
        if (!registration?.sponsored) throw new Error("expected loadConfig to populate registration.sponsored")

        const ports = await buildSponsoredRegistrationPorts(
            { ...registration, sponsored: registration.sponsored },
            RPC_URL
        )

        assert.equal(ports.writer.registry.address.toLowerCase(), baseConfig.identityRegistryAddress.toLowerCase())
    })
})
