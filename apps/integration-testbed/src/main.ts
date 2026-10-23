import assert from "node:assert/strict"
import { test } from "node:test"
import { getAddress, type Hex, hexToBytes } from "viem"
import { entryPoint08Address } from "viem/account-abstraction"
import { Identity } from "@coordination-network/account"
import type { Hex32 } from "@coordination-network/credential"
import { computeMemberNetworkId, deriveAccountKeypair } from "@coordination-network/identity"
import { Chain, connectToChain, requiredEnvironmentVariable, startChain } from "./anvil"
import { connectToBundler, startBundler, TestbedBundler } from "./alto-bundler"
import {
    deployCredentialRevocationRegistry,
    deployRevocationRegistry,
    deployStealthContracts,
    readArtifact,
    RevocationDeployment,
    StealthDeployment
} from "./deployer"
import { CONTRACTS_DIR, ERC5564_ANNOUNCER_ADDRESS, SEMAPHORE_ADDRESS, SIMPLE_7702_ACCOUNT_ADDRESS } from "./config"
import { deploymentFileFor, readDeploymentFile } from "./deployment-file"
import { deploySemaphore } from "./identity-deployer"
import { startTestbedIndexer, type TestbedIndexer } from "./indexer-harness"
import { personas } from "./personas"
import { runCredentialScenario } from "./scenario"
import { runStealthScenario } from "./stealth-scenario"

const mode = process.env.TESTBED_MODE ?? "multi-user"

type Deployments = {
    chain: Chain
    bundler: TestbedBundler
    memberIdentity: Identity
    issuerNetworkId: Hex32
    revocation: RevocationDeployment
    stealth: StealthDeployment
    indexerStartBlock: bigint
}

async function deployToALocalChain(diagnostic: (message: string) => void): Promise<Deployments> {
    const memberIdentity = new Identity(personas.networkMember.networkMemberIdentitySeed)
    const issuerNetworkId = personas.networkMember.networkId
    const chain = await startChain(diagnostic, { host: "0.0.0.0" })
    const revocationService = await deployRevocationRegistry(chain, diagnostic)
    const { semaphore } = await deploySemaphore(chain, diagnostic)

    const { result: networkMemberGroupId, request: createGroup } = await chain.publicClient.simulateContract({
        address: semaphore.address,
        abi: semaphore.abi,
        functionName: "createGroup",
        args: [chain.deployer],
        account: chain.deployer
    })
    const createGroupReceipt = await chain.publicClient.waitForTransactionReceipt({
        hash: await chain.walletClient.writeContract(createGroup)
    })
    const addMemberHash = await chain.walletClient.writeContract({
        address: semaphore.address,
        abi: semaphore.abi,
        functionName: "addMember",
        args: [networkMemberGroupId, memberIdentity.commitment],
        account: chain.deployer,
        chain: chain.chainDefinition
    })
    await chain.publicClient.waitForTransactionReceipt({ hash: addMemberHash })

    const credentialRevocation = await deployCredentialRevocationRegistry(
        chain,
        semaphore.address,
        networkMemberGroupId as bigint,
        revocationService.address,
        diagnostic
    )
    const stealth = await deployStealthContracts(chain, diagnostic)

    return {
        chain,
        bundler: await startBundler(chain, diagnostic),
        memberIdentity,
        issuerNetworkId,
        revocation: {
            abi: credentialRevocation.abi,
            address: credentialRevocation.address,
            registryId: credentialRevocation.registryId,
            revocationAbi: revocationService.abi,
            revocationAddress: revocationService.address,
            networkMemberGroupId: networkMemberGroupId as bigint,
            semaphoreAddress: semaphore.address,
            groupStartBlock: createGroupReceipt.blockNumber,
            chain
        },
        stealth,
        indexerStartBlock: 0n
    }
}

async function connectToADeployedNetwork(diagnostic: (message: string) => void): Promise<Deployments> {
    const chain = await connectToChain(diagnostic)
    const deployed = readDeploymentFile(deploymentFileFor(process.env.DEPLOYMENT_FILE, chain.chainDefinition.id))
    const testScopedToken = getAddress(requiredEnvironmentVariable("TEST_SCOPED_TOKEN"))

    const memberIdentitySecret = requiredEnvironmentVariable("MEMBER_IDENTITY_SECRET") as Hex
    const uncompressedAccountPublicKey = deriveAccountKeypair(memberIdentitySecret).uncompressedPublicKey
    const memberIdentity = new Identity(hexToBytes(memberIdentitySecret))
    const issuerNetworkId = computeMemberNetworkId(uncompressedAccountPublicKey)

    return {
        chain,
        bundler: connectToBundler(diagnostic),
        memberIdentity,
        issuerNetworkId,
        revocation: {
            abi: readArtifact(CONTRACTS_DIR, "out/CredentialRevocationRegistry.sol/CredentialRevocationRegistry.json")
                .abi,
            address: deployed.credentialRevocationRegistry,
            registryId: deployed.credentialRevocationRegistryId,
            revocationAbi: readArtifact(CONTRACTS_DIR, "out/Revocation.sol/Revocation.json").abi,
            revocationAddress: deployed.revocation,
            networkMemberGroupId: deployed.networkMemberGroupId,
            semaphoreAddress: SEMAPHORE_ADDRESS,
            groupStartBlock: deployed.blockNumber,
            chain
        },
        stealth: {
            announcer: {
                abi: readArtifact(CONTRACTS_DIR, "out/ERC5564Announcer.sol/ERC5564Announcer.json").abi,
                address: ERC5564_ANNOUNCER_ADDRESS
            },
            execution: {
                accountImplementation: {
                    abi: readArtifact(CONTRACTS_DIR, "out/Simple7702Account.sol/Simple7702Account.json").abi,
                    address: SIMPLE_7702_ACCOUNT_ADDRESS
                },
                entryPoint: {
                    abi: readArtifact(CONTRACTS_DIR, "out/EntryPoint.sol/EntryPoint.json").abi,
                    address: entryPoint08Address
                },
                paymaster: {
                    abi: readArtifact(CONTRACTS_DIR, "out/SemaphorePaymaster.sol/SemaphorePaymaster.json").abi,
                    address: deployed.semaphorePaymaster
                }
            },
            token: {
                abi: readArtifact(CONTRACTS_DIR, "out/TestScopedToken.sol/TestScopedToken.json").abi,
                address: testScopedToken
            },
            paymasterGroupStartBlock: deployed.blockNumber
        },
        indexerStartBlock: deployed.blockNumber
    }
}

test(`${mode} credential and stealth-address integration`, async (context) => {
    let deployments: Deployments | undefined
    let indexer: TestbedIndexer | undefined

    try {
        await context.test("prepares the chain, the bundler and the contracts", async (setupTest) => {
            const diagnostic = (message: string) => setupTest.diagnostic(message)
            deployments =
                mode === "testnet" ? await connectToADeployedNetwork(diagnostic) : await deployToALocalChain(diagnostic)
        })
        assert.ok(deployments, "the chain, bundler and contracts are not ready")
        const {
            chain: runningChain,
            bundler: runningBundler,
            memberIdentity,
            issuerNetworkId,
            revocation,
            stealth,
            indexerStartBlock
        } = deployments

        await context.test("starts the PostgreSQL-backed announcement indexer", async (indexerTest) => {
            indexer = await startTestbedIndexer(runningChain, stealth, indexerStartBlock, (message) =>
                indexerTest.diagnostic(message)
            )
        })
        const runningIndexer = indexer
        assert.ok(runningIndexer, "indexer failed to start")

        await context.test("issues, presents, verifies, and revokes a credential", async (credentialTest) => {
            await runCredentialScenario(revocation, memberIdentity, issuerNetworkId, (message) =>
                credentialTest.diagnostic(message)
            )
        })

        await context.test(
            "delivers, discovers, and transfers tokens through stealth addresses",
            async (stealthTest) => {
                await runStealthScenario(
                    runningChain,
                    stealth,
                    runningBundler,
                    runningIndexer,
                    { includeCharlie: mode === "multi-user" },
                    (message) => stealthTest.diagnostic(message)
                )
            }
        )
    } finally {
        await indexer?.stop()
        deployments?.bundler.stop()
        deployments?.chain.stop()
    }
})
