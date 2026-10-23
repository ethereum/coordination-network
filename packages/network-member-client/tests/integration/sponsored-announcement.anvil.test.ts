import { ChildProcess, execFileSync } from "node:child_process"
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals"
import {
    Account,
    Address,
    Chain,
    PublicClient,
    Transport,
    WalletClient,
    createPublicClient,
    createWalletClient,
    http,
    parseEventLogs
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { Identity } from "@semaphore-protocol/identity"
import { getCurveFromName, type Curve } from "ffjavascript"
import { deriveKeys, encodeMetaStealthAddress } from "@coordination-network/identity"
import type { Hex } from "@coordination-network/user-client"
import { SemaphoreGroupClient } from "../../src/adapters"
import { SponsoredAnnouncementSubmitter } from "../../src/sponsored-announcement"
import { SponsoredRelay } from "../../src/sponsored-relay"
import type { Announcement } from "../../src/types"
import { EntryPointSubmitter } from "../../src/user-operation"
import { addMember, deployStealthStack, loadArtifact, startAnvil } from "./chain"

// The first proof generation in a process downloads snark artifacts over the network; each
// sponsored call generates one real Semaphore proof (the paymaster's).
jest.setTimeout(120_000)

function anvilAvailable(): boolean {
    try {
        execFileSync("anvil", ["--version"], { stdio: "ignore" })
        return true
    } catch {
        return false
    }
}

const hasAnvil = anvilAvailable()
if (!hasAnvil && process.env.CI) {
    throw new Error("anvil is required for this integration test in CI but was not found on PATH")
}

const maybe = hasAnvil ? describe : describe.skip

// Distinct from every other suite's port, since they run in parallel workers.
const ANNOUNCEMENT_PORT = 18990
const ANNOUNCEMENT_RPC_URL = `http://127.0.0.1:${ANNOUNCEMENT_PORT}`

// anvil's first default funded account
const ADMIN_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const MEMBER_SECRET: Hex = `0x${"33".repeat(32)}`

const ANNOUNCEMENT: Announcement = {
    schemeId: 1,
    stealthAddress: `0x${"77".repeat(20)}` as Address,
    ephemeralPublicKey: `0x02${"88".repeat(32)}` as Hex,
    metadata: "0xab12cd" as Hex
}

maybe("sponsored announce through the Semaphore paymaster (anvil, port " + ANNOUNCEMENT_PORT + ")", () => {
    let anvil: ChildProcess
    let curve: Curve
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let announcer: Address
    let announcerAbi: ReturnType<typeof loadArtifact>["abi"]
    let submitter: SponsoredAnnouncementSubmitter

    beforeAll(async () => {
        curve = await getCurveFromName("bn128")
        anvil = await startAnvil(ANNOUNCEMENT_PORT)

        publicClient = createPublicClient({
            chain: foundry,
            transport: http(ANNOUNCEMENT_RPC_URL),
            pollingInterval: 50
        })
        wallet = createWalletClient({
            account: privateKeyToAccount(ADMIN_PRIVATE_KEY),
            chain: foundry,
            transport: http(ANNOUNCEMENT_RPC_URL),
            pollingInterval: 50
        })

        const announcerArtifact = loadArtifact("ERC5564Announcer")
        announcerAbi = announcerArtifact.abi
        const announcerHash = await wallet.deployContract({
            abi: announcerArtifact.abi,
            bytecode: announcerArtifact.bytecode,
            chain: foundry,
            account: wallet.account
        })
        const announcerReceipt = await publicClient.waitForTransactionReceipt({ hash: announcerHash })
        if (!announcerReceipt.contractAddress) throw new Error("ERC5564Announcer deployment failed")
        announcer = announcerReceipt.contractAddress

        const stealthStack = await deployStealthStack(wallet, publicClient, ANNOUNCEMENT_RPC_URL)
        const memberIdentity = new Identity("sponsored-announcement-integration-member")
        await addMember(
            wallet,
            publicClient,
            stealthStack.paymaster,
            stealthStack.paymasterAbi,
            stealthStack.paymasterGroupId,
            memberIdentity.commitment
        )

        const keys = deriveKeys(MEMBER_SECRET)
        // The admin key submits handleOps directly, standing in for the stack's bundler.
        const entryPointChainClient = {
            account: wallet.account,
            chain: wallet.chain,
            sendTransaction: wallet.sendTransaction,
            waitForTransactionReceipt: publicClient.waitForTransactionReceipt
        }
        submitter = new SponsoredAnnouncementSubmitter(
            announcer,
            new SponsoredRelay({
                chainId: foundry.id,
                entryPoint: stealthStack.entryPoint,
                paymaster: stealthStack.paymaster,
                accountImplementation: stealthStack.accountImplementation,
                memberKeys: {
                    metaStealthAddress: encodeMetaStealthAddress({
                        spendingPublicKey: keys.spending.publicKey,
                        viewingPublicKey: keys.viewing.publicKey
                    }),
                    spendingPrivateKey: keys.spending.privateKey,
                    viewingPrivateKey: keys.viewing.privateKey
                },
                paymasterIdentity: memberIdentity,
                paymasterGroup: new SemaphoreGroupClient(
                    stealthStack.paymaster,
                    stealthStack.paymasterGroupId,
                    publicClient
                ),
                submitter: new EntryPointSubmitter(entryPointChainClient, stealthStack.entryPoint),
                publicClient
            })
        )
    })

    afterAll(async () => {
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
        // snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
        await curve.terminate()
    })

    it("announces from a fresh sender that pays nothing, a different one each time", async () => {
        const hashes = [await submitter.announce(ANNOUNCEMENT), await submitter.announce(ANNOUNCEMENT)]

        const logs = await publicClient.getContractEvents({
            address: announcer,
            abi: announcerAbi,
            eventName: "Announcement",
            fromBlock: 0n
        })
        const callers = logs.map((log) => (log.args as { caller: Address }).caller)

        expect(callers).toHaveLength(2)
        expect(callers[0]).not.toBe(callers[1])
        for (const caller of callers) {
            expect(caller).not.toBe(wallet.account.address)
            expect(await publicClient.getBalance({ address: caller })).toBe(0n)
        }
        expect((logs[0].args as { stealthAddress: Address }).stealthAddress).toBe(ANNOUNCEMENT.stealthAddress)

        expect(hashes[0]).not.toBe(hashes[1])
        for (const [index, hash] of hashes.entries()) {
            const receipt = await publicClient.getTransactionReceipt({ hash })
            const [announcement] = parseEventLogs({
                abi: announcerAbi,
                eventName: "Announcement",
                logs: receipt.logs.filter((log) => log.address.toLowerCase() === announcer.toLowerCase())
            })
            expect((announcement.args as { caller: Address }).caller).toBe(callers[index])
        }
    })
})
