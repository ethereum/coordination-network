import { ChildProcess, execFileSync } from "node:child_process"
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals"
import {
    Abi,
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
import { UpdateAction } from "@coordination-network/network-member-proof"
import { buildRegistrationRequest, onboard } from "@coordination-network/user-client"
import type { ChainDomain, Hex } from "@coordination-network/user-client"
import { submitRegistration } from "../../src/submit"
import {
    IdentityRegistryClient,
    IdentityRegistryWriter,
    SemaphoreGroupClient,
    SemaphoreRegistrationProver
} from "../../src/adapters"
import type { IdentityReader } from "../../src/types"
import { PORT, RPC_URL, addMember, deployRegistry, removeMember, startAnvil } from "./chain"

// The first proof generation in a process downloads snark artifacts over the network.
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

const DEVICE_SECRET_A: Hex = `0x${"11".repeat(32)}`
const DEVICE_SECRET_RACE: Hex = `0x${"22".repeat(32)}`

/** Returns null once, then delegates — simulates a caller whose reader hasn't caught up with a
 *  registration someone else just won the race on. */
function staleOnceReader(real: IdentityReader): IdentityReader {
    let stale = true
    return {
        async getIdentity(networkId) {
            if (stale) {
                stale = false
                return null
            }
            return real.getIdentity(networkId)
        }
    }
}

maybe("submitRegistration against IdentityRegistry (anvil, port " + PORT + ")", () => {
    let anvil: ChildProcess
    let curve: Curve
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let registryAddress: Address
    let semaphoreAddress: Address
    let semaphoreAbi: Abi
    let groupId: bigint
    let domain: ChainDomain
    let reader: IdentityRegistryClient
    let groupMirror: SemaphoreGroupClient
    let memberIdentity: Identity
    let prover: SemaphoreRegistrationProver
    let writer: IdentityRegistryWriter

    beforeAll(async () => {
        curve = await getCurveFromName("bn128")
        anvil = await startAnvil()

        publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ADMIN_PRIVATE_KEY),
            chain: foundry,
            transport: http(RPC_URL),
            pollingInterval: 50
        })

        const deployment = await deployRegistry(wallet, publicClient, wallet.account.address, RPC_URL)
        registryAddress = deployment.registry
        semaphoreAddress = deployment.semaphore
        semaphoreAbi = deployment.semaphoreAbi
        groupId = deployment.groupId
        domain = { chainId: foundry.id, verifyingContract: registryAddress }

        reader = new IdentityRegistryClient(registryAddress, publicClient)
        groupMirror = new SemaphoreGroupClient(semaphoreAddress, groupId, publicClient)
        writer = new IdentityRegistryWriter({ chainId: BigInt(foundry.id), address: registryAddress }, wallet)

        memberIdentity = new Identity("submit-registration-integration-member")
        prover = new SemaphoreRegistrationProver({
            identity: memberIdentity,
            groupMirror,
            registry: { chainId: BigInt(foundry.id), address: registryAddress }
        })
        await addMember(wallet, publicClient, semaphoreAddress, semaphoreAbi, groupId, memberIdentity.commitment)
    })

    afterAll(async () => {
        // kill() only sends the signal; wait for the process to actually exit, or its handle
        // lingers in the event loop past jest's own exit check. Node never re-emits "exit" for
        // an already-exited child, so only wait if it is still alive.
        if (anvil && anvil.exitCode === null && anvil.signalCode === null) {
            await new Promise<void>((resolve) => {
                anvil.once("exit", () => resolve())
                anvil.kill()
            })
        }
        // snarkjs keeps a bn128 curve worker pool alive; without this the run never exits.
        await curve.terminate()
    })

    // Each case below is self-contained aside from sharing the one deployment from beforeAll — a
    // distinct device secret per case keeps `-t` or `it.only` on any single one working.
    it("registers on the real registry, reads back the entry, and is idempotent on a second submission", async () => {
        const { keys, networkId, metaStealthAddress } = onboard(DEVICE_SECRET_A)
        const request = buildRegistrationRequest(keys, domain)
        const proveSpy = jest.spyOn(prover, "prove")

        const first = await submitRegistration(request, { domain, identityReader: reader, prover, writer })
        expect(first).toMatchObject({ status: "submitted", networkId, metaStealthAddress })
        if (first.status !== "submitted") throw new Error("expected submitted")
        expect(first.txHash).toBeTruthy()
        expect(proveSpy).toHaveBeenCalledWith({ action: UpdateAction.Register, networkId, metaStealthAddress })

        // The writer returns as soon as the write is submitted, not once it lands (matching
        // deliverToStealth's txHash contract), so the read-back needs its own confirmation.
        await publicClient.waitForTransactionReceipt({ hash: first.txHash })
        expect(await reader.getIdentity(networkId)).toBe(metaStealthAddress)

        proveSpy.mockClear()
        const second = await submitRegistration(request, { domain, identityReader: reader, prover, writer })
        expect(second).toEqual({ status: "alreadyRegistered", networkId, metaStealthAddress, matchesRequest: true })
        expect(proveSpy).not.toHaveBeenCalled()

        proveSpy.mockRestore()
    })

    it("maps a lost AlreadyRegistered race, against the real registry, back to alreadyRegistered", async () => {
        const { keys, networkId, metaStealthAddress } = onboard(DEVICE_SECRET_RACE)
        const request = buildRegistrationRequest(keys, domain)

        // Registers directly, bypassing submitRegistration, standing in for a concurrent caller
        // who wins the race between this test's stale read and its write. Confirmed before the
        // real submission below, so that one deterministically lands after and reverts.
        const winningProof = await prover.prove({ action: UpdateAction.Register, networkId, metaStealthAddress })
        const winningWrite = await writer.registerIdentity(networkId, metaStealthAddress, winningProof)
        await publicClient.waitForTransactionReceipt({ hash: winningWrite.txHash })

        const result = await submitRegistration(request, {
            domain,
            identityReader: staleOnceReader(reader),
            prover,
            writer
        })

        expect(result).toEqual({ status: "alreadyRegistered", networkId, metaStealthAddress, matchesRequest: true })
    })

    it("mirrors the group root through an addMember and a removeMember", async () => {
        const identity = new Identity("submit-registration-mirror-check-member")
        await addMember(wallet, publicClient, semaphoreAddress, semaphoreAbi, groupId, identity.commitment)

        let group = await groupMirror.currentGroup()
        let onChainRoot = await publicClient.readContract({
            address: semaphoreAddress,
            abi: semaphoreAbi,
            functionName: "getMerkleTreeRoot",
            args: [groupId]
        })
        expect(group.root).toBe(onChainRoot)
        const index = group.indexOf(identity.commitment)
        expect(index).not.toBe(-1)

        const siblings = group.generateMerkleProof(index).siblings
        await removeMember(wallet, publicClient, semaphoreAddress, semaphoreAbi, groupId, identity.commitment, siblings)

        group = await groupMirror.currentGroup()
        onChainRoot = await publicClient.readContract({
            address: semaphoreAddress,
            abi: semaphoreAbi,
            functionName: "getMerkleTreeRoot",
            args: [groupId]
        })
        expect(group.root).toBe(onChainRoot)
        expect(group.indexOf(identity.commitment)).toBe(-1)
    })
})
