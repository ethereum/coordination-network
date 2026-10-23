import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    createPublicClient,
    createTestClient,
    createWalletClient,
    http,
    parseAbi,
    type Abi,
    type Address,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { buildAnnouncement, encodeMetaStealthAddress } from "@coordination-network/identity"

const ANVIL_PORT = 8545
export const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`

// anvil's first default funded account
const DEPLOYER_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

export const ANNOUNCER_ARTIFACT_PATH = join(
    __dirname,
    "../../../../packages/contracts/out/ERC5564Announcer.sol/ERC5564Announcer.json"
)

export const SCOPED_TOKEN_ARTIFACT_PATH = join(
    __dirname,
    "../../../../packages/contracts/out/TestScopedToken.sol/TestScopedToken.json"
)

export const announcerAbi = parseAbi([
    "function announce(uint256 schemeId, address stealthAddress, bytes ephemeralPubKey, bytes metadata)"
])

export const scopedTokenAbi = parseAbi(["function mint(address account, uint256 id, uint256 amount)"])

export const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) })
const walletClient = createWalletClient({
    account: privateKeyToAccount(DEPLOYER_PRIVATE_KEY),
    chain: foundry,
    transport: http(RPC_URL)
})

export const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC_URL) })

/** Mines empty blocks, so a catch-up has more to walk through than one scan interval allows. */
export async function mineBlocks(blocks: number) {
    await testClient.mine({ blocks })
}

export async function startAnvil(): Promise<ChildProcess> {
    // a run killed before its afterAll leaves anvil running
    spawnSync("pkill", ["-f", `anvil --port ${ANVIL_PORT}`])

    const anvil = spawn("anvil", ["--port", String(ANVIL_PORT)], { stdio: "ignore" })
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            await publicClient.getBlockNumber()
            return anvil
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    throw new Error(`anvil did not start on ${RPC_URL}`)
}

/** Deploys a contract foundry has already compiled. Neither of ours takes constructor arguments. */
export async function deployContractFromArtifact(artifactPath: string, abi: Abi): Promise<Address> {
    const artifact = JSON.parse(readFileSync(artifactPath, "utf8"))
    const hash = await walletClient.deployContract({ abi, bytecode: artifact.bytecode.object })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    assert.ok(receipt.contractAddress, `${artifactPath} deployment should return a contract address`)
    return receipt.contractAddress
}

export async function mintScopedToken(token: Address, stealthAddress: Address, tokenId: bigint, amount: bigint) {
    const hash = await walletClient.writeContract({
        address: token,
        abi: scopedTokenAbi,
        functionName: "mint",
        args: [stealthAddress, tokenId, amount]
    })
    await publicClient.waitForTransactionReceipt({ hash })
}

export function buildAnnouncementFor({
    spendingPublicKey,
    viewingPublicKey
}: {
    spendingPublicKey: Hex
    viewingPublicKey: Hex
}) {
    const metaStealthAddress = encodeMetaStealthAddress({ spendingPublicKey, viewingPublicKey })
    return buildAnnouncement({ metaStealthAddress })
}

export async function announceOnchain(announcer: Address, announcement: ReturnType<typeof buildAnnouncement>) {
    const hash = await walletClient.writeContract({
        address: announcer,
        abi: announcerAbi,
        functionName: "announce",
        args: [
            BigInt(announcement.schemeId),
            announcement.stealthAddress,
            announcement.ephemeralPublicKey,
            announcement.metadata
        ]
    })
    await publicClient.waitForTransactionReceipt({ hash })
}
