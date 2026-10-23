import { ChildProcess, execFileSync, spawn } from "child_process"
import { readFileSync } from "fs"
import { createRequire } from "module"
import { join } from "path"
import {
    Abi,
    createPublicClient,
    createTestClient,
    createWalletClient,
    http,
    keccak256,
    PublicClient,
    WalletClient
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { Hex32, NetworkMemberRegistryClient } from "@coordination-network/credential"

const POSEIDON_T3 = "0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93" as const
const POSEIDON_T4 = "0x4443338EF595F44e0121df4C21102677B142ECF0" as const

// The registry takes a member's account key and derives its id as keccak256(X || Y), so the approved
// member is a real key. viem's public key is `0x04` followed by X and Y.
const APPROVED_PUBLIC_KEY = privateKeyToAccount(`0x${"15".repeat(32)}`).publicKey
const APPROVED_KEY_X = BigInt(`0x${APPROVED_PUBLIC_KEY.slice(4, 68)}`)
const APPROVED_KEY_Y = BigInt(`0x${APPROVED_PUBLIC_KEY.slice(68)}`)
const APPROVED_ID = keccak256(`0x${APPROVED_PUBLIC_KEY.slice(4)}`) as Hex32
const UNAPPROVED_ID = `0x${"bb".repeat(32)}` as Hex32
// Approving a member publishes its Semaphore commitment and its governance signer, the seat it
// holds at the governance Safe.
const APPROVED_COMMITMENT = 1n
const APPROVED_GOVERNANCE_SIGNER = `0x${"dd".repeat(20)}` as `0x${string}`
const PORT = 18965
const RPC_URL = `http://127.0.0.1:${PORT}`
// anvil's first default funded account
const OWNER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
const CONTRACTS_DIR = join(__dirname, "..", "..", "..", "contracts")

/**
 * Integration test against a real NetworkMemberRegistry on a local anvil
 * node: one approved member, one never approved, one removed.
 */
describe("NetworkMemberRegistryClient (anvil)", () => {
    let anvil: ChildProcess
    let client: NetworkMemberRegistryClient
    let registryAddress: `0x${string}`
    let abi: Abi
    let wallet: WalletClient
    let publicClient: PublicClient

    beforeAll(async () => {
        execFileSync("forge", ["build"], { cwd: CONTRACTS_DIR, stdio: "ignore" })
        const artifact = JSON.parse(
            readFileSync(join(CONTRACTS_DIR, "out", "NetworkMemberRegistry.sol", "NetworkMemberRegistry.json"), "utf8")
        )
        abi = artifact.abi
        const issuerSetArtifact = JSON.parse(
            readFileSync(join(CONTRACTS_DIR, "out", "ApprovedIssuerSet.sol", "ApprovedIssuerSet.json"), "utf8")
        )
        // Poseidon is deployed from the bytecode its own package ships, not from a local
        // recompilation. Rebuilt under this repo's `via_ir` profile the libraries come out over the
        // EIP-170 contract size limit and cannot be deployed at all; the shipped build is the one
        // that lives at poseidon-solidity's deterministic addresses on real chains.
        const requirePoseidon = createRequire(join(CONTRACTS_DIR, "package.json"))
        const poseidonDeployments = [
            { name: "PoseidonT3", canonicalAddress: POSEIDON_T3 },
            { name: "PoseidonT4", canonicalAddress: POSEIDON_T4 }
        ].map(({ name, canonicalAddress }) => ({
            name,
            canonicalAddress,
            bytecode: requirePoseidon(`poseidon-solidity/deploy/${name}.js`).bytecode as `0x${string}`
        }))

        anvil = spawn("anvil", ["--port", String(PORT)], { stdio: "ignore" })
        publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) })
        for (let i = 0; ; i++) {
            try {
                await publicClient.getChainId()
                break
            } catch {
                if (i > 50) throw new Error("anvil did not start")
                await new Promise((r) => setTimeout(r, 100))
            }
        }

        const owner = privateKeyToAccount(OWNER_KEY)
        wallet = createWalletClient({ account: owner, chain: foundry, transport: http(RPC_URL) })
        const deployHash = await wallet.deployContract({
            abi,
            bytecode: artifact.bytecode.object,
            args: [owner.address],
            chain: foundry,
            account: owner
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
        if (!receipt.contractAddress) throw new Error("registry deployment failed")
        registryAddress = receipt.contractAddress

        // The registry retires a removed member's signing keys, so it refuses to remove anyone until
        // it knows where they live. Deploy order is registry, then set, then wire.
        //
        // The set is compiled with Poseidon's mainnet addresses written into it, so this chain has
        // to hold the same code there.
        const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC_URL) })
        for (const { name, bytecode, canonicalAddress } of poseidonDeployments) {
            const poseidonHash = await wallet.sendTransaction({
                data: bytecode,
                chain: foundry,
                account: owner
            })
            const poseidonReceipt = await publicClient.waitForTransactionReceipt({ hash: poseidonHash })
            if (!poseidonReceipt.contractAddress) throw new Error(`${name} deployment failed`)

            const poseidonCode = await publicClient.getBytecode({ address: poseidonReceipt.contractAddress })
            if (!poseidonCode) throw new Error(`deployed ${name} has no runtime bytecode`)
            await testClient.setCode({ address: canonicalAddress, bytecode: poseidonCode })
        }

        const issuerSetHash = await wallet.deployContract({
            abi: issuerSetArtifact.abi,
            bytecode: issuerSetArtifact.bytecode.object as `0x${string}`,
            args: [registryAddress],
            chain: foundry,
            account: owner
        })
        const issuerSetReceipt = await publicClient.waitForTransactionReceipt({ hash: issuerSetHash })
        if (!issuerSetReceipt.contractAddress) throw new Error("issuer set deployment failed")

        const wireHash = await wallet.writeContract({
            address: registryAddress,
            abi,
            functionName: "setApprovedIssuerSet",
            args: [issuerSetReceipt.contractAddress],
            chain: foundry,
            account: owner
        })
        await publicClient.waitForTransactionReceipt({ hash: wireHash })

        const approveHash = await wallet.writeContract({
            address: registryAddress,
            abi,
            functionName: "approveNetworkMember",
            args: [APPROVED_KEY_X, APPROVED_KEY_Y, APPROVED_COMMITMENT, APPROVED_GOVERNANCE_SIGNER],
            chain: foundry,
            account: owner
        })
        await publicClient.waitForTransactionReceipt({ hash: approveHash })

        client = new NetworkMemberRegistryClient(registryAddress, RPC_URL)
    }, 120_000)

    afterAll(() => {
        anvil?.kill()
    })

    it("resolves an approved network member to true", async () => {
        expect(await client.isApprovedNetworkMember(APPROVED_ID)).toBe(true)
    })

    it("resolves an unapproved network member to false", async () => {
        expect(await client.isApprovedNetworkMember(UNAPPROVED_ID)).toBe(false)
    })

    it("resolves to false again after removal", async () => {
        const hash = await wallet.writeContract({
            address: registryAddress,
            abi,
            functionName: "removeNetworkMember",
            args: [APPROVED_ID],
            chain: foundry,
            account: wallet.account!
        })
        await publicClient.waitForTransactionReceipt({ hash })
        expect(await client.isApprovedNetworkMember(APPROVED_ID)).toBe(false)
    })
})
