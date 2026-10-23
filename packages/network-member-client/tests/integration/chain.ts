import { ChildProcess, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
    Abi,
    Account,
    Address,
    Chain,
    PublicClient,
    Transport,
    WalletClient,
    createPublicClient,
    createTestClient,
    http,
    parseEther
} from "viem"
import { entryPoint08Address } from "viem/account-abstraction"
import { foundry } from "viem/chains"

export const POSEIDON_T3 = "0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93" as const

export const PORT = 18969
export const RPC_URL = `http://127.0.0.1:${PORT}`

// A second, distinct port: this suite runs alongside submit-registration.anvil.test.ts, each in
// its own worker process, and both would otherwise race to bind PORT.
export const SPONSORED_PORT = 18970
export const SPONSORED_RPC_URL = `http://127.0.0.1:${SPONSORED_PORT}`

const CONTRACTS_OUT = join(__dirname, "..", "..", "..", "contracts", "out")

type Wallet = WalletClient<Transport, Chain, Account>

export async function startAnvil(port: number = PORT): Promise<ChildProcess> {
    const rpcUrl = `http://127.0.0.1:${port}`
    const publicClient = createPublicClient({ chain: foundry, transport: http(rpcUrl) })

    // A stray node already on this port would otherwise pass the readiness poll below, running
    // the suite against whatever that is instead of the anvil we spawn.
    let alreadyListening = true
    try {
        await publicClient.getBlockNumber()
    } catch {
        alreadyListening = false
    }
    if (alreadyListening) {
        throw new Error(`something already listens on ${rpcUrl} (a leftover anvil?); stop it before running this suite`)
    }

    // Prague, for EIP-7702 (the sponsored-registration suite delegates a stealth EOA to Simple7702Account).
    const anvil = spawn("anvil", ["--port", String(port), "--hardfork", "prague"], { stdio: "ignore" })

    let earlyExit: string | undefined
    anvil.once("exit", (code, signal) => {
        earlyExit = `anvil exited before becoming ready (code ${code}, signal ${signal})`
    })
    anvil.once("error", (error) => {
        earlyExit = `anvil failed to start: ${error.message}`
    })

    for (let attempt = 0; attempt < 50; attempt += 1) {
        if (earlyExit) throw new Error(earlyExit)
        try {
            await publicClient.getBlockNumber()
            return anvil
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    anvil.kill()
    throw new Error(`anvil did not start on ${rpcUrl}`)
}

type LinkReferences = Record<string, Record<string, Array<{ start: number; length: number }>>>

export function loadArtifact(name: string): { abi: Abi; bytecode: `0x${string}`; linkReferences: LinkReferences } {
    const path = join(CONTRACTS_OUT, `${name}.sol`, `${name}.json`)
    let raw: string
    try {
        raw = readFileSync(path, "utf8")
    } catch {
        throw new Error(`missing ${name} artifact at ${path}; run \`yarn build:contracts\``)
    }
    const artifact = JSON.parse(raw)
    return {
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        linkReferences: artifact.bytecode.linkReferences ?? {}
    }
}

export interface DeployedRegistry {
    semaphore: Address
    registry: Address
    groupId: bigint
    semaphoreAbi: Abi
    registryAbi: Abi
}

/**
 * Deploys SemaphoreVerifier -> Semaphore -> a fresh admin-owned group -> IdentityRegistry pointed
 * at it.
 *
 * `rpcUrl` is taken rather than assumed, as {@link deployStealthStack} already does: the one
 * `anvil_setCode` below needs a test client of its own, and reaching for the module-level
 * `RPC_URL` pointed it at whichever chain that constant names. Both suites here run in their own
 * worker against their own anvil, so for the sponsored one that was the *other* suite's node, and
 * it only ever worked while that node happened to still be listening.
 */
export async function deployRegistry(
    wallet: Wallet,
    publicClient: PublicClient,
    admin: Address,
    rpcUrl: string
): Promise<DeployedRegistry> {
    const verifierArtifact = loadArtifact("SemaphoreVerifier")
    const verifierHash = await wallet.deployContract({
        abi: verifierArtifact.abi,
        bytecode: verifierArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const verifierReceipt = await publicClient.waitForTransactionReceipt({ hash: verifierHash })
    if (!verifierReceipt.contractAddress) throw new Error("SemaphoreVerifier deployment failed")

    // Semaphore is compiled with PoseidonT3's mainnet address written into it, so this chain has to
    // hold the same code there.
    const poseidonArtifact = loadArtifact("PoseidonT3")
    const poseidonHash = await wallet.deployContract({
        abi: poseidonArtifact.abi,
        bytecode: poseidonArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const poseidonReceipt = await publicClient.waitForTransactionReceipt({ hash: poseidonHash })
    if (!poseidonReceipt.contractAddress) throw new Error("PoseidonT3 deployment failed")
    const poseidonCode = await publicClient.getBytecode({ address: poseidonReceipt.contractAddress })
    if (!poseidonCode) throw new Error("deployed PoseidonT3 has no runtime bytecode")
    const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) })
    await testClient.setCode({ address: POSEIDON_T3, bytecode: poseidonCode })

    const semaphoreArtifact = loadArtifact("Semaphore")
    const semaphoreHash = await wallet.deployContract({
        abi: semaphoreArtifact.abi,
        bytecode: semaphoreArtifact.bytecode,
        args: [verifierReceipt.contractAddress],
        chain: foundry,
        account: wallet.account
    })
    const semaphoreReceipt = await publicClient.waitForTransactionReceipt({ hash: semaphoreHash })
    if (!semaphoreReceipt.contractAddress) throw new Error("Semaphore deployment failed")
    const semaphore = semaphoreReceipt.contractAddress

    // simulateContract, not writeContract, because createGroup's return value (the groupId) is only
    // observable through a call, not a transaction hash.
    const { result: groupId, request } = await publicClient.simulateContract({
        address: semaphore,
        abi: semaphoreArtifact.abi,
        functionName: "createGroup",
        args: [admin],
        account: wallet.account
    })
    const createGroupHash = await wallet.writeContract(request)
    await publicClient.waitForTransactionReceipt({ hash: createGroupHash })

    const registryArtifact = loadArtifact("IdentityRegistry")
    const registryHash = await wallet.deployContract({
        abi: registryArtifact.abi,
        bytecode: registryArtifact.bytecode,
        args: [semaphore, groupId],
        chain: foundry,
        account: wallet.account
    })
    const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: registryHash })
    if (!registryReceipt.contractAddress) throw new Error("IdentityRegistry deployment failed")

    return {
        semaphore,
        registry: registryReceipt.contractAddress,
        groupId: groupId as bigint,
        semaphoreAbi: semaphoreArtifact.abi,
        registryAbi: registryArtifact.abi
    }
}

/** Admits `commitment` to `groupId`, as the group's admin. */
export async function addMember(
    wallet: Wallet,
    publicClient: PublicClient,
    semaphore: Address,
    semaphoreAbi: Abi,
    groupId: bigint,
    commitment: bigint
): Promise<void> {
    const hash = await wallet.writeContract({
        address: semaphore,
        abi: semaphoreAbi,
        functionName: "addMember",
        args: [groupId, commitment],
        chain: foundry,
        account: wallet.account
    })
    await publicClient.waitForTransactionReceipt({ hash })
}

export interface StealthStackDeployment {
    entryPoint: Address
    entryPointAbi: Abi
    accountImplementation: Address
    paymaster: Address
    paymasterAbi: Abi
    paymasterGroupId: bigint
}

/**
 * Deploys the EIP-7702/ERC-4337 pieces the sponsored-registration suite needs: the EntryPoint at
 * its canonical v0.8 address (via `anvil_setCode`, the only way to make its runtime bytecode live
 * where 7702 delegation and viem's own `entryPoint08Address` both expect it), Simple7702Account,
 * and a funded, staked SemaphorePaymaster with its own Semaphore group.
 */
export async function deployStealthStack(
    wallet: Wallet,
    publicClient: PublicClient,
    rpcUrl: string
): Promise<StealthStackDeployment> {
    const entryPointArtifact = loadArtifact("EntryPoint")
    const temporaryEntryPointHash = await wallet.deployContract({
        abi: entryPointArtifact.abi,
        bytecode: entryPointArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const temporaryEntryPointReceipt = await publicClient.waitForTransactionReceipt({ hash: temporaryEntryPointHash })
    if (!temporaryEntryPointReceipt.contractAddress) throw new Error("EntryPoint deployment failed")
    const entryPointCode = await publicClient.getBytecode({ address: temporaryEntryPointReceipt.contractAddress })
    if (!entryPointCode) throw new Error("deployed EntryPoint has no runtime bytecode")

    const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) })
    await testClient.setCode({ address: entryPoint08Address, bytecode: entryPointCode })

    const accountImplementationArtifact = loadArtifact("Simple7702Account")
    const accountImplementationHash = await wallet.deployContract({
        abi: accountImplementationArtifact.abi,
        bytecode: accountImplementationArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const accountImplementationReceipt = await publicClient.waitForTransactionReceipt({
        hash: accountImplementationHash
    })
    if (!accountImplementationReceipt.contractAddress) throw new Error("Simple7702Account deployment failed")

    const verifierArtifact = loadArtifact("SemaphoreVerifier")
    const verifierHash = await wallet.deployContract({
        abi: verifierArtifact.abi,
        bytecode: verifierArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const verifierReceipt = await publicClient.waitForTransactionReceipt({ hash: verifierHash })
    if (!verifierReceipt.contractAddress) throw new Error("SemaphoreVerifier deployment failed")

    // Same as Semaphore above: the paymaster carries PoseidonT3's pinned address, not a placeholder.
    const poseidonArtifact = loadArtifact("PoseidonT3")
    const poseidonHash = await wallet.deployContract({
        abi: poseidonArtifact.abi,
        bytecode: poseidonArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const poseidonReceipt = await publicClient.waitForTransactionReceipt({ hash: poseidonHash })
    if (!poseidonReceipt.contractAddress) throw new Error("PoseidonT3 deployment failed")
    const paymasterPoseidonCode = await publicClient.getBytecode({ address: poseidonReceipt.contractAddress })
    if (!paymasterPoseidonCode) throw new Error("deployed PoseidonT3 has no runtime bytecode")
    await createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) }).setCode({
        address: POSEIDON_T3,
        bytecode: paymasterPoseidonCode
    })

    const paymasterArtifact = loadArtifact("SemaphorePaymaster")
    const paymasterHash = await wallet.deployContract({
        abi: paymasterArtifact.abi,
        bytecode: paymasterArtifact.bytecode,
        args: [entryPoint08Address, verifierReceipt.contractAddress, wallet.account.address, parseEther("0.05")],
        chain: foundry,
        account: wallet.account
    })
    const paymasterReceipt = await publicClient.waitForTransactionReceipt({ hash: paymasterHash })
    if (!paymasterReceipt.contractAddress) throw new Error("SemaphorePaymaster deployment failed")
    const paymaster = paymasterReceipt.contractAddress

    const depositHash = await wallet.writeContract({
        address: paymaster,
        abi: paymasterArtifact.abi,
        functionName: "deposit",
        chain: foundry,
        account: wallet.account,
        value: parseEther("1")
    })
    await publicClient.waitForTransactionReceipt({ hash: depositHash })

    const stakeHash = await wallet.writeContract({
        address: paymaster,
        abi: paymasterArtifact.abi,
        functionName: "addStake",
        args: [1n],
        chain: foundry,
        account: wallet.account,
        value: parseEther("1")
    })
    await publicClient.waitForTransactionReceipt({ hash: stakeHash })

    const paymasterGroupId = (await publicClient.readContract({
        address: paymaster,
        abi: paymasterArtifact.abi,
        functionName: "GROUP_ID"
    })) as bigint

    return {
        entryPoint: entryPoint08Address,
        entryPointAbi: entryPointArtifact.abi,
        accountImplementation: accountImplementationReceipt.contractAddress,
        paymaster,
        paymasterAbi: paymasterArtifact.abi,
        paymasterGroupId
    }
}

/** Removes `commitment` from `groupId`, as the group's admin. Needs the Merkle proof for its leaf. */
export async function removeMember(
    wallet: Wallet,
    publicClient: PublicClient,
    semaphore: Address,
    semaphoreAbi: Abi,
    groupId: bigint,
    commitment: bigint,
    merkleProofSiblings: bigint[]
): Promise<void> {
    const hash = await wallet.writeContract({
        address: semaphore,
        abi: semaphoreAbi,
        functionName: "removeMember",
        args: [groupId, commitment, merkleProofSiblings],
        chain: foundry,
        account: wallet.account
    })
    await publicClient.waitForTransactionReceipt({ hash })
}
