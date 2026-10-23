import { ChildProcess, execFileSync, spawn } from "node:child_process"
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

// Copied from packages/network-member-client/tests/integration/chain.ts, parameterised by port
// instead of a fixed constant: this file's own e2e suite and registrations.e2e.test.ts each need
// their own anvil, on their own port, in the same node:test process tree.
const CONTRACTS_DIR = join(__dirname, "..", "..", "..", "packages", "contracts")
const CONTRACTS_OUT = join(CONTRACTS_DIR, "out")

const POSEIDON_T3 = "0x3333333C0A88F9BE4fd23ed0536F9B6c427e3B93" as const
const POSEIDON_T4 = "0x4443338EF595F44e0121df4C21102677B142ECF0" as const

type Wallet = WalletClient<Transport, Chain, Account>

export async function startAnvil(port: number): Promise<ChildProcess> {
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

    // Raised so Poseidon's constant-heavy bytecode (PoseidonT4, used by the revocation registry)
    // deploys under anvil's default EIP-170 size cap; harmless for the smaller contracts this
    // helper also deploys.
    const anvil = spawn("anvil", ["--port", String(port), "--code-size-limit", "1000000"], { stdio: "ignore" })

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

export function loadArtifact(
    name: string,
    dir: string = CONTRACTS_OUT
): { abi: Abi; bytecode: `0x${string}`; linkReferences: LinkReferences } {
    const path = join(dir, `${name}.sol`, `${name}.json`)
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
    execFileSync("forge", ["build"], { cwd: CONTRACTS_DIR, stdio: "ignore" })

    const verifierArtifact = loadArtifact("SemaphoreVerifier")
    const verifierHash = await wallet.deployContract({
        abi: verifierArtifact.abi,
        bytecode: verifierArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const verifierReceipt = await publicClient.waitForTransactionReceipt({ hash: verifierHash })
    if (!verifierReceipt.contractAddress) throw new Error("SemaphoreVerifier deployment failed")

    const testClient = createTestClient({
        chain: foundry,
        mode: "anvil",
        transport: http(publicClient.transport.url as string)
    })
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

export interface DeployedRevocation {
    address: Address
    abi: Abi
    registryId: bigint
}

/**
 * Creates another registry on an already-deployed `Revocation`, admin-owned by `admin`, for a
 * test that needs two issuers revoking independently on the same contract.
 * @param rootDuration How long a superseded root stays valid; see {@link deployRevocation}.
 */
export async function createRegistry(
    wallet: Wallet,
    publicClient: PublicClient,
    address: Address,
    admin: Address,
    rootDuration = 0n
): Promise<bigint> {
    const { abi } = loadArtifact("Revocation", CONTRACTS_OUT)
    const { result: registryId, request } = await publicClient.simulateContract({
        address,
        abi,
        functionName: "createRegistry",
        args: [admin, rootDuration],
        account: wallet.account
    })
    const hash = await wallet.writeContract(request)
    await publicClient.waitForTransactionReceipt({ hash })
    return registryId as bigint
}

/**
 * Deploys `Revocation` and creates one registry on it, admin-owned by `admin`.
 * @param rootDuration How long a superseded root stays valid. Zero by default, so a test observes
 * a revocation's effect on `isValidRoot` immediately instead of within the production default's
 * one-hour grace window.
 */
/**
 * `packages/contracts` pins both Poseidon libraries at fixed addresses, so artifacts carry them
 * baked in and nothing is linked at deploy time. They have to exist at those addresses instead.
 */
async function deployPoseidonLibraries(wallet: Wallet, publicClient: PublicClient): Promise<void> {
    const testClient = createTestClient({
        chain: foundry,
        mode: "anvil",
        transport: http(publicClient.transport.url as string)
    })
    for (const [name, canonicalAddress] of [
        ["PoseidonT3", POSEIDON_T3],
        ["PoseidonT4", POSEIDON_T4]
    ] as const) {
        const artifact = loadArtifact(name, CONTRACTS_OUT)
        const hash = await wallet.deployContract({
            abi: artifact.abi,
            bytecode: artifact.bytecode,
            chain: foundry,
            account: wallet.account
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (!receipt.contractAddress) throw new Error(`${name} deployment failed`)
        const code = await publicClient.getBytecode({ address: receipt.contractAddress })
        if (!code) throw new Error(`deployed ${name} has no runtime bytecode`)
        await testClient.setCode({ address: canonicalAddress, bytecode: code })
    }
}

export async function deployRevocation(
    wallet: Wallet,
    publicClient: PublicClient,
    admin: Address,
    rootDuration = 0n
): Promise<DeployedRevocation> {
    execFileSync("forge", ["build"], { cwd: CONTRACTS_DIR, stdio: "ignore" })

    await deployPoseidonLibraries(wallet, publicClient)

    const revocationArtifact = loadArtifact("Revocation", CONTRACTS_OUT)
    const deployHash = await wallet.deployContract({
        abi: revocationArtifact.abi,
        bytecode: revocationArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const deployReceipt = await publicClient.waitForTransactionReceipt({ hash: deployHash })
    if (!deployReceipt.contractAddress) throw new Error("Revocation deployment failed")

    const registryId = await createRegistry(wallet, publicClient, deployReceipt.contractAddress, admin, rootDuration)

    return { address: deployReceipt.contractAddress, abi: revocationArtifact.abi, registryId }
}

export interface DeployedCredentialRevocationRegistry {
    /** The `Revocation` service holding the tree; the registry below is its admin. */
    revocation: Address
    revocationAbi: Abi
    registry: Address
    registryAbi: Abi
    /** The registry's own id on `revocation`, read back off the contract. */
    registryId: bigint
    semaphore: Address
    semaphoreAbi: Abi
    /** The approved-member group every write proves membership in. */
    groupId: bigint
}

/**
 * Deploys Semaphore, a fresh `groupAdmin`-owned approved-member group, a `Revocation` service and
 * the `CredentialRevocationRegistry` gating writes on that group. The registry creates its own
 * registry on the service at construction, taking the one-hour default root window, so there is no
 * duration to pass.
 *
 * It sits on top of {@link deployRevocation}, whose own registry nothing here uses: that leaves the
 * credential registry on a non-zero id, which is what makes "the id is read off the contract"
 * observable rather than accidentally right.
 */
export async function deployCredentialRevocationRegistry(
    wallet: Wallet,
    publicClient: PublicClient,
    groupAdmin: Address
): Promise<DeployedCredentialRevocationRegistry> {
    const revocation = await deployRevocation(wallet, publicClient, groupAdmin)

    const verifierArtifact = loadArtifact("SemaphoreVerifier")
    const verifierHash = await wallet.deployContract({
        abi: verifierArtifact.abi,
        bytecode: verifierArtifact.bytecode,
        chain: foundry,
        account: wallet.account
    })
    const verifierReceipt = await publicClient.waitForTransactionReceipt({ hash: verifierHash })
    if (!verifierReceipt.contractAddress) throw new Error("SemaphoreVerifier deployment failed")

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
        args: [groupAdmin],
        account: wallet.account
    })
    const createGroupHash = await wallet.writeContract(request)
    await publicClient.waitForTransactionReceipt({ hash: createGroupHash })

    const registryArtifact = loadArtifact("CredentialRevocationRegistry")
    const registryHash = await wallet.deployContract({
        abi: registryArtifact.abi,
        bytecode: registryArtifact.bytecode,
        args: [semaphore, groupId, revocation.address],
        chain: foundry,
        account: wallet.account
    })
    const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: registryHash })
    if (!registryReceipt.contractAddress) throw new Error("CredentialRevocationRegistry deployment failed")

    const registryId = (await publicClient.readContract({
        address: registryReceipt.contractAddress,
        abi: registryArtifact.abi,
        functionName: "REGISTRY_ID"
    })) as bigint

    return {
        revocation: revocation.address,
        revocationAbi: revocation.abi,
        registry: registryReceipt.contractAddress,
        registryAbi: registryArtifact.abi,
        registryId,
        semaphore,
        semaphoreAbi: semaphoreArtifact.abi,
        groupId: groupId as bigint
    }
}

/**
 * Moves anvil's clock forward. The mine is not optional: a root's validity window compares
 * `block.timestamp`, so the bump only reaches a contract once a block carries it.
 */
export async function advanceTime(rpcUrl: string, seconds: number): Promise<void> {
    const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(rpcUrl) })
    await testClient.increaseTime({ seconds })
    await testClient.mine({ blocks: 1 })
}

export interface DeployedIssuerSet {
    registry: Address
    registryAbi: Abi
    issuerSet: Address
    issuerSetAbi: Abi
}

/**
 * Deploys `NetworkMemberRegistry` (governed by `governance`) and an `ApprovedIssuerSet` bound to
 * it, then wires the set onto the registry. A member still needs `approveNetworkMember` before
 * `publishIssuerKey` will accept a key for it: the set refuses to publish for an unapproved member
 * even when the caller is governance.
 */
export async function deployApprovedIssuerSet(
    wallet: Wallet,
    publicClient: PublicClient,
    governance: Address
): Promise<DeployedIssuerSet> {
    execFileSync("forge", ["build"], { cwd: CONTRACTS_DIR, stdio: "ignore" })

    const registryArtifact = loadArtifact("NetworkMemberRegistry")
    const registryHash = await wallet.deployContract({
        abi: registryArtifact.abi,
        bytecode: registryArtifact.bytecode,
        args: [governance],
        chain: foundry,
        account: wallet.account
    })
    const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: registryHash })
    if (!registryReceipt.contractAddress) throw new Error("NetworkMemberRegistry deployment failed")

    await deployPoseidonLibraries(wallet, publicClient)

    const issuerSetArtifact = loadArtifact("ApprovedIssuerSet")
    const issuerSetHash = await wallet.deployContract({
        abi: issuerSetArtifact.abi,
        bytecode: issuerSetArtifact.bytecode,
        args: [registryReceipt.contractAddress],
        chain: foundry,
        account: wallet.account
    })
    const issuerSetReceipt = await publicClient.waitForTransactionReceipt({ hash: issuerSetHash })
    if (!issuerSetReceipt.contractAddress) throw new Error("ApprovedIssuerSet deployment failed")

    // approveNetworkMember refuses to run until this is wired, mirroring the deploy-time onboarding
    // sequence in packages/contracts/docs/configuration/network-member-onboarding.md.
    const wireHash = await wallet.writeContract({
        address: registryReceipt.contractAddress,
        abi: registryArtifact.abi,
        functionName: "setApprovedIssuerSet",
        args: [issuerSetReceipt.contractAddress],
        chain: foundry,
        account: wallet.account
    })
    await publicClient.waitForTransactionReceipt({ hash: wireHash })

    return {
        registry: registryReceipt.contractAddress,
        registryAbi: registryArtifact.abi,
        issuerSet: issuerSetReceipt.contractAddress,
        issuerSetAbi: issuerSetArtifact.abi
    }
}
