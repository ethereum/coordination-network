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
    http
} from "viem"
import { foundry } from "viem/chains"

export const POSEIDON_T3 = "0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93" as const

export const PORT = 18968
export const RPC_URL = `http://127.0.0.1:${PORT}`

const CONTRACTS_OUT = join(__dirname, "..", "..", "..", "contracts", "out")

type Wallet = WalletClient<Transport, Chain, Account>

export async function startAnvil(): Promise<ChildProcess> {
    const publicClient = createPublicClient({ chain: foundry, transport: http(RPC_URL) })

    // A stray node already on this port would otherwise pass the readiness poll below, running
    // the suite against whatever that is instead of the anvil we spawn.
    let alreadyListening = true
    try {
        await publicClient.getBlockNumber()
    } catch {
        alreadyListening = false
    }
    if (alreadyListening) {
        throw new Error(
            `something already listens on ${RPC_URL} (a leftover anvil?); stop it before running this suite`
        )
    }

    const anvil = spawn("anvil", ["--port", String(PORT)], { stdio: "ignore" })

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
    throw new Error(`anvil did not start on ${RPC_URL}`)
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

/** Deploys SemaphoreVerifier -> Semaphore -> a fresh admin-owned group -> IdentityRegistry pointed at it. */
export async function deployRegistry(
    wallet: Wallet,
    publicClient: PublicClient,
    admin: Address
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

    const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC_URL) })
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
