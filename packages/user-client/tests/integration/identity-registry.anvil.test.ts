import { execFileSync, ChildProcess } from "node:child_process"
import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals"
import {
    Abi,
    Account,
    Address,
    BaseError,
    Chain,
    ContractFunctionRevertedError,
    PublicClient,
    Transport,
    WalletClient,
    createPublicClient,
    createWalletClient,
    http
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { foundry } from "viem/chains"
import { Group } from "@semaphore-protocol/group"
import { Identity } from "@semaphore-protocol/identity"
import { getCurveFromName, type Curve } from "ffjavascript"
import { generateSemaphoreProof, NetworkMemberProof, UpdateAction } from "@coordination-network/network-member-proof"
import { IdentityRegistryClient } from "@coordination-network/network-member-client"
import { onboard, register } from "../../src/register"
import { verifyRegistrationRequest } from "../../src/request"
import { InMemoryIdentityRegistry } from "../../src/registry"
import { SubmissionFailedError } from "../../src/errors"
import { ChainDomain, Hex, RegistrationRequest, RegistrationSubmitter, SubmissionReceipt } from "../../src/types"
import { RPC_URL, addMember, deployRegistry, startAnvil } from "./chain"

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
const DEVICE_SECRET_B: Hex = `0x${"22".repeat(32)}`
const DEVICE_SECRET_C: Hex = `0x${"33".repeat(32)}`
const DEVICE_SECRET_D: Hex = `0x${"44".repeat(32)}`
const DEVICE_SECRET_E: Hex = `0x${"55".repeat(32)}`

/** The revert's decoded error name, if `error` (or something it wraps) is a contract revert. */
function revertErrorName(error: unknown): string | undefined {
    if (!(error instanceof BaseError)) return undefined
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    return revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined
}

/** Asserts `runFake` throws a SubmissionFailedError whose message starts with `errorName` — what
 *  keeps InMemoryIdentityRegistry's "pinned against the real contract" claim actually pinned. */
function expectFakeToRevertLike(errorName: string, runFake: () => void): void {
    let caught: unknown
    try {
        runFake()
    } catch (error) {
        caught = error
    }
    expect(caught).toBeInstanceOf(SubmissionFailedError)
    expect((caught as SubmissionFailedError).message.startsWith(errorName)).toBe(true)
}

/**
 * Integration test against a real IdentityRegistry on a local anvil node, gated on Semaphore
 * membership the way the deployed contract is. Skipped when foundry is not installed.
 */
maybe("register() against IdentityRegistry (anvil)", () => {
    let anvil: ChildProcess
    let curve: Curve
    let publicClient: PublicClient
    let wallet: WalletClient<Transport, Chain, Account>
    let registryAddress: Address
    let registryAbi: Abi
    let semaphoreAddress: Address
    let groupId: bigint
    let domain: ChainDomain
    let reader: IdentityRegistryClient
    let memberIdentity: Identity
    let group: Group

    /** Stands in for an approved network member's server: checks consent, then submits on chain. */
    class AnvilMemberSubmitter implements RegistrationSubmitter {
        async submit(request: RegistrationRequest): Promise<SubmissionReceipt> {
            if (!verifyRegistrationRequest(request, domain)) {
                throw new SubmissionFailedError("InvalidRegistrationRequest")
            }
            try {
                return await registerAsMember(request.networkId, request.metaStealthAddress)
            } catch (error) {
                throw new SubmissionFailedError(revertErrorName(error) ?? "SubmissionFailed", error)
            }
        }
    }

    /** Registers directly on chain, with no consent check — the network member's own authority. */
    async function registerAsMember(networkId: Hex, metaStealthAddress: Hex): Promise<{ txHash: Hex }> {
        const proof = await generateSemaphoreProof({
            identity: memberIdentity,
            group,
            registry: { chainId: BigInt(domain.chainId), address: registryAddress },
            update: { action: UpdateAction.Register, networkId, metaStealthAddress }
        })
        const hash = await wallet.writeContract({
            address: registryAddress,
            abi: registryAbi,
            functionName: "registerIdentity",
            args: [networkId, metaStealthAddress, proof],
            chain: foundry,
            account: wallet.account
        })
        await publicClient.waitForTransactionReceipt({ hash })
        return { txHash: hash }
    }

    beforeAll(async () => {
        curve = await getCurveFromName("bn128")
        anvil = await startAnvil()
        // A short pollingInterval bounds how long a receipt-wait's last poll cycle lingers after
        // the transaction is already mined: viem's poll() only reads its "stop" flag at the start
        // of the next cycle, so one full interval survives every waitForTransactionReceipt call.
        // anvil auto-mines, so there is no accuracy cost to polling fast.
        publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL), pollingInterval: 50 })
        wallet = createWalletClient({
            account: privateKeyToAccount(ADMIN_PRIVATE_KEY),
            chain: foundry,
            transport: http(RPC_URL),
            pollingInterval: 50
        })

        const deployment = await deployRegistry(wallet, publicClient, wallet.account.address)
        registryAddress = deployment.registry
        registryAbi = deployment.registryAbi
        semaphoreAddress = deployment.semaphore
        groupId = deployment.groupId
        domain = { chainId: foundry.id, verifyingContract: registryAddress }
        reader = new IdentityRegistryClient(registryAddress, publicClient)

        memberIdentity = new Identity("integration-member")
        group = new Group([memberIdentity.commitment])

        await addMember(
            wallet,
            publicClient,
            semaphoreAddress,
            deployment.semaphoreAbi,
            groupId,
            memberIdentity.commitment
        )
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
    it("resolves an unregistered networkId to null", async () => {
        const { networkId } = onboard(DEVICE_SECRET_C)

        await expect(reader.getIdentity(networkId)).resolves.toBeNull()
    })

    it("registers on the real contract and reads back the same meta-stealth address", async () => {
        const { networkId, metaStealthAddress } = onboard(DEVICE_SECRET_A)

        const result = await register({
            deviceSecret: DEVICE_SECRET_A,
            registry: reader,
            submitter: new AnvilMemberSubmitter(),
            domain
        })

        expect(result.status).toBe("registered")
        if (result.status !== "registered") throw new Error("expected registered")
        expect(result.receipt.txHash).toBeTruthy()

        const stored = await reader.getIdentity(networkId)
        expect(stored).toBe(metaStealthAddress)
        expect(stored).not.toBeNull()
        expect((stored!.length - 2) / 2).toBe(66)
    })

    it("is idempotent against the real contract: a second call with the same device secret returns alreadyRegistered", async () => {
        const { metaStealthAddress } = onboard(DEVICE_SECRET_D)

        const first = await register({
            deviceSecret: DEVICE_SECRET_D,
            registry: reader,
            submitter: new AnvilMemberSubmitter(),
            domain
        })
        expect(first.status).toBe("registered")

        const second = await register({
            deviceSecret: DEVICE_SECRET_D,
            registry: reader,
            submitter: new AnvilMemberSubmitter(),
            domain
        })

        expect(second).toMatchObject({
            status: "alreadyRegistered",
            metaStealthAddress,
            derivedMetaStealthAddress: metaStealthAddress,
            matchesDerived: true
        })
    })

    it("reverts AlreadyRegistered on a direct second registration of the same networkId", async () => {
        const { networkId, metaStealthAddress } = onboard(DEVICE_SECRET_E)

        await registerAsMember(networkId, metaStealthAddress)

        let caught: unknown
        try {
            await registerAsMember(networkId, metaStealthAddress)
        } catch (error) {
            caught = error
        }

        expect(revertErrorName(caught)).toBe("AlreadyRegistered")

        const fake = new InMemoryIdentityRegistry()
        fake.registerIdentity(networkId, metaStealthAddress)
        expectFakeToRevertLike("AlreadyRegistered", () => fake.registerIdentity(networkId, metaStealthAddress))
    })

    it("reverts InvalidMetaStealthAddressLength on a direct registration with a malformed meta-stealth address", async () => {
        // _updateMessage runs as the onlyNetworkMember modifier's argument, so its length check
        // reverts before the proof is ever checked — a dummy proof reaches the same revert a real
        // one would.
        const networkId: Hex = `0x${"cc".repeat(32)}`
        const malformedMetaStealthAddress: Hex = `0x${"ab".repeat(65)}`
        const dummyProof: NetworkMemberProof = {
            merkleTreeDepth: 1n,
            merkleTreeRoot: 0n,
            nullifier: 0n,
            scope: 0n,
            points: [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]
        }

        let caught: unknown
        try {
            await wallet.writeContract({
                address: registryAddress,
                abi: registryAbi,
                functionName: "registerIdentity",
                args: [networkId, malformedMetaStealthAddress, dummyProof],
                chain: foundry,
                account: wallet.account
            })
        } catch (error) {
            caught = error
        }

        expect(revertErrorName(caught)).toBe("InvalidMetaStealthAddressLength")

        const fake = new InMemoryIdentityRegistry()
        expectFakeToRevertLike("InvalidMetaStealthAddressLength", () =>
            fake.registerIdentity(networkId, malformedMetaStealthAddress)
        )
    })

    it("flags a chain entry this device secret does not derive", async () => {
        const { networkId, metaStealthAddress: derivedMetaStealthAddress } = onboard(DEVICE_SECRET_B)
        const { metaStealthAddress: mismatchedMetaStealthAddress } = onboard(DEVICE_SECRET_A)

        await registerAsMember(networkId, mismatchedMetaStealthAddress)

        const result = await register({
            deviceSecret: DEVICE_SECRET_B,
            registry: reader,
            submitter: new AnvilMemberSubmitter(),
            domain
        })

        expect(result).toMatchObject({
            status: "alreadyRegistered",
            metaStealthAddress: mismatchedMetaStealthAddress,
            derivedMetaStealthAddress,
            matchesDerived: false
        })
    })
})
