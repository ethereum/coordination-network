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
    http
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { Identity } from "@semaphore-protocol/identity"
import { getCurveFromName, type Curve } from "ffjavascript"
import { deriveKeys, encodeMetaStealthAddress } from "@coordination-network/identity"
import { UpdateAction } from "@coordination-network/network-member-proof"
import { onboard } from "@coordination-network/user-client"
import type { Hex } from "@coordination-network/user-client"
import { IdentityRegistryClient, SemaphoreGroupClient, SemaphoreRegistrationProver } from "../../src/adapters"
import { RegistryRevertError } from "../../src/errors"
import { SponsoredIdentityRegistryWriter } from "../../src/sponsored"
import { EntryPointSubmitter } from "../../src/user-operation"
import { SPONSORED_PORT, SPONSORED_RPC_URL, addMember, deployRegistry, deployStealthStack, startAnvil } from "./chain"

// The first proof generation in a process downloads snark artifacts over the network; two
// sponsored calls each generate two real Semaphore proofs (registry membership + paymaster).
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

// anvil's first default funded account
const ADMIN_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const
const MEMBER_SECRET: Hex = `0x${"33".repeat(32)}`
const DEVICE_SECRET: Hex = `0x${"11".repeat(32)}`

maybe("sponsored registerIdentity through the Semaphore paymaster (anvil, port " + SPONSORED_PORT + ")", () => {
    let anvil: ChildProcess
    let curve: Curve
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let registryAddress: Address
    let reader: IdentityRegistryClient
    let prover: SemaphoreRegistrationProver
    let writer: SponsoredIdentityRegistryWriter
    let paymaster: Address
    let paymasterAbi: Awaited<ReturnType<typeof deployStealthStack>>["paymasterAbi"]

    beforeAll(async () => {
        curve = await getCurveFromName("bn128")
        anvil = await startAnvil(SPONSORED_PORT)

        publicClient = createPublicClient({ chain: foundry, transport: http(SPONSORED_RPC_URL), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ADMIN_PRIVATE_KEY),
            chain: foundry,
            transport: http(SPONSORED_RPC_URL),
            pollingInterval: 50
        })

        const registryDeployment = await deployRegistry(wallet, publicClient, wallet.account.address, SPONSORED_RPC_URL)
        registryAddress = registryDeployment.registry
        const registry = { chainId: BigInt(foundry.id), address: registryAddress }

        // One identity plays both roles the sponsored flow needs a proof from: an approved
        // network member (the registry's own group) and an approved paymaster sponsor (the
        // paymaster's own group) — the same shortcut the stack takes in production.
        const memberIdentity = new Identity("sponsored-registration-integration-member")
        await addMember(
            wallet,
            publicClient,
            registryDeployment.semaphore,
            registryDeployment.semaphoreAbi,
            registryDeployment.groupId,
            memberIdentity.commitment
        )

        const stealthStack = await deployStealthStack(wallet, publicClient, SPONSORED_RPC_URL)
        paymaster = stealthStack.paymaster
        paymasterAbi = stealthStack.paymasterAbi
        await addMember(
            wallet,
            publicClient,
            paymaster,
            paymasterAbi,
            stealthStack.paymasterGroupId,
            memberIdentity.commitment
        )

        reader = new IdentityRegistryClient(registryAddress, publicClient)
        prover = new SemaphoreRegistrationProver({
            identity: memberIdentity,
            groupMirror: new SemaphoreGroupClient(
                registryDeployment.semaphore,
                registryDeployment.groupId,
                publicClient
            ),
            registry
        })

        const keys = deriveKeys(MEMBER_SECRET)
        const memberKeys = {
            metaStealthAddress: encodeMetaStealthAddress({
                spendingPublicKey: keys.spending.publicKey,
                viewingPublicKey: keys.viewing.publicKey
            }),
            spendingPrivateKey: keys.spending.privateKey,
            viewingPrivateKey: keys.viewing.privateKey
        }

        // No separate bundler here: the admin key submits handleOps directly, the way the stack's
        // own bundler (T1b) and this test both do, standing in for a real member-server bundler.
        const entryPointChainClient = {
            account: wallet.account,
            chain: wallet.chain,
            sendTransaction: wallet.sendTransaction,
            waitForTransactionReceipt: publicClient.waitForTransactionReceipt
        }
        writer = new SponsoredIdentityRegistryWriter({
            registry,
            chainId: foundry.id,
            entryPoint: stealthStack.entryPoint,
            paymaster,
            accountImplementation: stealthStack.accountImplementation,
            memberKeys,
            paymasterIdentity: memberIdentity,
            paymasterGroup: new SemaphoreGroupClient(paymaster, stealthStack.paymasterGroupId, publicClient),
            submitter: new EntryPointSubmitter(entryPointChainClient, stealthStack.entryPoint),
            publicClient
        })
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

    it("sponsors the registration, costing the sender nothing, and maps a repeat to AlreadyRegistered", async () => {
        const { networkId, metaStealthAddress } = onboard(DEVICE_SECRET)
        const proof = await prover.prove({ action: UpdateAction.Register, networkId, metaStealthAddress })

        const write = await writer.registerIdentity(networkId, metaStealthAddress, proof)

        const { sponsorship } = write
        if (!sponsorship) throw new Error("expected a sponsored write to report sponsorship")
        expect(sponsorship.senderBalanceBefore).toBe(0n)
        expect(sponsorship.senderBalanceAfter).toBe(0n)
        expect(sponsorship.paymasterDepositAfter).toBeLessThan(sponsorship.paymasterDepositBefore)
        expect(sponsorship.actualGasCost).toBeGreaterThan(0n)
        expect(sponsorship.paymaster).toBe(paymaster)

        expect(await reader.getIdentity(networkId)).toBe(metaStealthAddress)

        // A second relay for the same networkId, through a fresh disposable sender, hits the
        // registry's own AlreadyRegistered — proving the sponsored path's off-chain userOpHash
        // matched what the EntryPoint validated against (a mismatch fails validation with AA24,
        // not a clean revert this test could observe as AlreadyRegistered).
        const secondProof = await prover.prove({ action: UpdateAction.Register, networkId, metaStealthAddress })
        const repeat = writer.registerIdentity(networkId, metaStealthAddress, secondProof)

        await expect(repeat).rejects.toBeInstanceOf(RegistryRevertError)
        await expect(repeat).rejects.toMatchObject({ errorName: "AlreadyRegistered" })
    })
})
