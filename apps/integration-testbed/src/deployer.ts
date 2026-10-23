import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { Abi, Address, createTestClient, createWalletClient, Hex, http, parseEther } from "viem"
import { entryPoint08Address } from "viem/account-abstraction"
import { PoseidonT3, PoseidonT4, proxy as deploymentFactoryProxy } from "poseidon-solidity"
import { Identity } from "@semaphore-protocol/identity"
import { fetchPaymasterSemaphoreGroup } from "@coordination-network/account"
import { generateRevocationProof, RevocationAction } from "@coordination-network/network-member-proof"
import {
    DirectRevocationWriter,
    SemaphoreGroupClient,
    SemaphoreRevocationProver
} from "@coordination-network/network-member-client"
import { Chain, DedicatedAnvil } from "./anvil"
import { CONTRACTS_DIR, TESTBED_CHAIN } from "./config"

/** Not a real commitment: a credential's is a Poseidon hash, which cannot be 1. */
const SEED_COMMITMENT = 1n

export interface ForgeArtifact {
    abi: Abi
    bytecode: {
        object: string
        linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>
    }
    deployedBytecode?: {
        object: string
    }
}

export interface RevocationDeployment {
    abi: Abi
    address: Address
    registryId: bigint
    revocationAbi: Abi
    revocationAddress: Address
    networkMemberGroupId: bigint
    semaphoreAddress: Address
    groupStartBlock: bigint
    chain: Chain
}

export interface ContractDeployment {
    abi: Abi
    address: Address
}

export interface StealthDeployment {
    announcer: ContractDeployment
    execution: {
        accountImplementation: ContractDeployment
        entryPoint: ContractDeployment
        paymaster: ContractDeployment
    }
    token: ContractDeployment
    paymasterGroupStartBlock: bigint
}

export function readArtifact(directory: string, path: string): ForgeArtifact {
    return JSON.parse(readFileSync(join(directory, path), "utf8")) as ForgeArtifact
}

export function buildContracts(directory: string): void {
    execFileSync("forge", ["build"], { cwd: directory, stdio: "ignore" })
}

/**
 * `packages/contracts` pins PoseidonT3 and PoseidonT4 at fixed addresses (its `foundry.toml`), so
 * every artifact carries them baked in and nothing is link-time substituted. They have to exist at
 * those addresses instead, which the deterministic factory guarantees on a fresh chain.
 */
async function deployDeterministicFactory(anvil: DedicatedAnvil): Promise<Address> {
    const factory = deploymentFactoryProxy.address as Address
    if (await anvil.publicClient.getCode({ address: factory })) return factory

    const fundingHash = await anvil.walletClient.sendTransaction({
        to: deploymentFactoryProxy.from as Address,
        value: BigInt(deploymentFactoryProxy.gas),
        account: anvil.deployer,
        chain: TESTBED_CHAIN
    })
    await anvil.publicClient.waitForTransactionReceipt({ hash: fundingHash })

    const factoryHash = await anvil.walletClient.sendRawTransaction({
        serializedTransaction: deploymentFactoryProxy.tx as Hex
    })
    await anvil.publicClient.waitForTransactionReceipt({ hash: factoryHash })
    return factory
}

async function deployToAddress(anvil: DedicatedAnvil, factoryCalldata: Hex, address: Address): Promise<void> {
    const factory = await deployDeterministicFactory(anvil)
    if (await anvil.publicClient.getCode({ address })) return

    const hash = await anvil.walletClient.sendTransaction({
        to: factory,
        data: factoryCalldata,
        account: anvil.deployer,
        chain: TESTBED_CHAIN
    })
    await anvil.publicClient.waitForTransactionReceipt({ hash })
    if (!(await anvil.publicClient.getCode({ address }))) {
        throw new Error(`deployment did not land on ${address}`)
    }
}

export async function deployPoseidon(anvil: DedicatedAnvil, poseidon: typeof PoseidonT3): Promise<void> {
    await deployToAddress(anvil, poseidon.data as Hex, poseidon.address as Address)
}

export async function deployContract(
    anvil: DedicatedAnvil,
    artifact: ForgeArtifact,
    args: readonly unknown[] = []
): Promise<ContractDeployment> {
    const hash = await anvil.walletClient.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object as Hex,
        args,
        account: anvil.deployer,
        chain: TESTBED_CHAIN
    })
    const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash })
    if (!receipt.contractAddress) throw new Error("contract deployment failed")
    return { abi: artifact.abi, address: receipt.contractAddress }
}

export async function deployRevocationRegistry(
    anvil: DedicatedAnvil,
    diagnostic: (message: string) => void = () => {}
): Promise<ContractDeployment> {
    buildContracts(CONTRACTS_DIR)

    const artifact = readArtifact(CONTRACTS_DIR, "out/Revocation.sol/Revocation.json")

    await deployPoseidon(anvil, PoseidonT3)
    await deployPoseidon(anvil, PoseidonT4)

    const deployHash = await anvil.walletClient.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object as Hex,
        account: anvil.deployer,
        chain: TESTBED_CHAIN
    })
    const receipt = await anvil.publicClient.waitForTransactionReceipt({ hash: deployHash })
    if (!receipt.contractAddress) throw new Error("revocation registry deployment failed")

    const createHash = await anvil.walletClient.writeContract({
        address: receipt.contractAddress,
        abi: artifact.abi,
        functionName: "createRegistry",
        args: [anvil.deployer, 0n],
        account: anvil.deployer,
        chain: TESTBED_CHAIN
    })
    await anvil.publicClient.waitForTransactionReceipt({ hash: createHash })

    diagnostic(`Revocation registry ${receipt.contractAddress}`)
    return { abi: artifact.abi, address: receipt.contractAddress }
}

export async function deployStealthContracts(
    anvil: DedicatedAnvil,
    diagnostic: (message: string) => void = () => {}
): Promise<StealthDeployment> {
    buildContracts(CONTRACTS_DIR)

    const announcer = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/ERC5564Announcer.sol/ERC5564Announcer.json")
    )
    const token = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/TestScopedToken.sol/TestScopedToken.json")
    )

    const entryPointArtifact = readArtifact(CONTRACTS_DIR, "out/EntryPoint.sol/EntryPoint.json")
    const temporaryEntryPoint = await deployContract(anvil, entryPointArtifact)
    const entryPointCode = await anvil.publicClient.getBytecode({ address: temporaryEntryPoint.address })
    if (!entryPointCode) throw new Error("deployed EntryPoint has no runtime bytecode")
    const testClient = createTestClient({ chain: TESTBED_CHAIN, mode: "anvil", transport: http(anvil.rpcUrl) })
    await testClient.setCode({ address: entryPoint08Address, bytecode: entryPointCode })
    const entryPoint = { abi: entryPointArtifact.abi, address: entryPoint08Address }

    const accountImplementation = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/Simple7702Account.sol/Simple7702Account.json")
    )
    const verifier = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/SemaphoreVerifier.sol/SemaphoreVerifier.json")
    )
    const paymaster = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/SemaphorePaymaster.sol/SemaphorePaymaster.json"),
        [entryPoint.address, verifier.address, anvil.deployer, parseEther("0.05")]
    )
    const paymasterGroupStartBlock = await anvil.publicClient.getBlockNumber()

    const depositHash = await anvil.walletClient.writeContract({
        address: paymaster.address,
        abi: paymaster.abi,
        functionName: "deposit",
        account: anvil.deployer,
        chain: TESTBED_CHAIN,
        value: parseEther("1")
    })
    await anvil.publicClient.waitForTransactionReceipt({ hash: depositHash })

    const stakeHash = await anvil.walletClient.writeContract({
        address: paymaster.address,
        abi: paymaster.abi,
        functionName: "addStake",
        args: [1n],
        account: anvil.deployer,
        chain: TESTBED_CHAIN,
        value: parseEther("1")
    })
    await anvil.publicClient.waitForTransactionReceipt({ hash: stakeHash })

    diagnostic(`ERC-5564 announcer ${announcer.address}`)
    diagnostic(`Mock ERC-1155 token ${token.address}`)
    diagnostic(`ERC-4337 EntryPoint ${entryPoint.address}`)
    diagnostic(`Semaphore paymaster ${paymaster.address}; deposit 1 ETH`)
    return { announcer, execution: { accountImplementation, entryPoint, paymaster }, token, paymasterGroupStartBlock }
}

export async function submitRevocation(
    deployment: RevocationDeployment,
    memberIdentity: Identity,
    commitment: bigint,
    lowLeafIndex: bigint
): Promise<void> {
    const { chain } = deployment
    const group = await fetchPaymasterSemaphoreGroup({
        rpcUrl: chain.rpcUrl,
        semaphoreContract: deployment.semaphoreAddress,
        groupId: deployment.networkMemberGroupId,
        startBlock: deployment.groupStartBlock,
        blockScanWindowSize: chain.blockScanWindowSize
    })
    const proof = await generateRevocationProof({
        identity: memberIdentity,
        group,
        registry: { address: deployment.address, chainId: BigInt(chain.chainDefinition.id) },
        update: { action: RevocationAction.Revoke, revocationCommitment: commitment }
    })

    const hash = await chain.walletClient.writeContract({
        address: deployment.address,
        abi: deployment.abi,
        functionName: "revoke",
        args: [commitment, lowLeafIndex, proof],
        account: chain.signer,
        chain: chain.chainDefinition
    })
    await chain.publicClient.waitForTransactionReceipt({ hash })
}

export interface CredentialRevocationDeployment {
    abi: Abi
    address: Address
    /** Created by the contract for itself at construction, so it is read back rather than chosen. */
    registryId: bigint
}

/**
 * The network's one revocation registry. It needs the approved-member group to gate writes on, so
 * it can only be deployed once governance has created that group.
 */
export async function deployCredentialRevocationRegistry(
    anvil: DedicatedAnvil,
    semaphore: Address,
    networkMemberGroupId: bigint,
    revocation: Address,
    diagnostic: (message: string) => void = () => {}
): Promise<CredentialRevocationDeployment> {
    const { abi, address } = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/CredentialRevocationRegistry.sol/CredentialRevocationRegistry.json"),
        [semaphore, networkMemberGroupId, revocation]
    )
    const registryId = (await anvil.publicClient.readContract({
        address,
        abi,
        functionName: "REGISTRY_ID"
    })) as bigint

    diagnostic(`Credential revocation registry ${address} (registry ${registryId} on ${revocation})`)
    return { abi, address, registryId }
}

/**
 * Puts one unused commitment in the tree at deployment. The service never stamps a supersede time
 * for the empty-tree root, so that root alone gets no grace window and the network's first real
 * revocation would invalidate any proof built a moment earlier. A commitment is
 * `Poseidon2(revocationPubX, revocationPubY)`, so `1` cannot collide with a credential's.
 *
 * Any approved member may write, so the first founder's identity signs it. No bundler is needed:
 * no write path reads `msg.sender`, and the bundler has not started at this point anyway.
 */
export async function seedCredentialRevocationRegistry(
    anvil: DedicatedAnvil,
    registry: CredentialRevocationDeployment,
    semaphore: Address,
    groupId: bigint,
    memberSecret: Uint8Array,
    deployBlock: bigint,
    diagnostic: (message: string) => void = () => {}
): Promise<void> {
    const location = { chainId: BigInt(TESTBED_CHAIN.id), address: registry.address }
    const prover = new SemaphoreRevocationProver({
        identity: new Identity(memberSecret),
        groupMirror: new SemaphoreGroupClient(semaphore, groupId, anvil.publicClient, { fromBlock: deployBlock }),
        registry: location
    })
    const proof = await prover.prove({ action: RevocationAction.Revoke, revocationCommitment: SEED_COMMITMENT })

    // The stack's wallet client binds no account, so the deployer is bound here as a JSON-RPC
    // account: anvil has it unlocked, and the writer signs through the node rather than a key.
    const wallet = createWalletClient({
        account: anvil.deployer,
        chain: TESTBED_CHAIN,
        transport: http(anvil.rpcUrl)
    })
    await new DirectRevocationWriter(location, wallet).revoke(SEED_COMMITMENT, 0n, proof)

    diagnostic(`Seeded the revocation tree with commitment ${SEED_COMMITMENT}, so no proof meets an empty root`)
}
