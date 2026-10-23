import {
    decodeEventLog,
    encodeFunctionData,
    getAddress,
    isAddressEqual,
    parseAbi,
    zeroAddress,
    type Address,
    type Hex
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import {
    buildSafeTransactionData,
    encodeExecTransaction,
    governanceThreshold,
    hashSafeTransaction,
    memberAccountKey,
    onChainApproval,
    type MetaTransactionData,
    type SafeContext,
    type SafeVersion
} from "@coordination-network/network-member-governance"
import { EddsaPublicKey } from "@coordination-network/credential"
import { DedicatedAnvil } from "./anvil"
import { CONTRACTS_DIR, TESTBED_CHAIN } from "./config"
import { buildContracts, ContractDeployment, deployContract, readArtifact } from "./deployer"
import { SemaphoreDeployment } from "./identity-deployer"

/** The one event this file reads off `SafeProxyFactory`, typed narrowly for `decodeEventLog`. */
const PROXY_CREATION_ABI = parseAbi(["event ProxyCreation(address indexed proxy, address singleton)"])

/** A founding member: everything the genesis Safe transactions and the issuer-key publication need. */
export interface GovernanceFounder {
    networkId: Hex
    /** The account key `networkId` hashes; sends `publishIssuerKey`. */
    authPrivateKey: Hex
    /** This founder's seat on the Safe; owns the founding transactions below. */
    governanceSignerPrivateKey: Hex
    /** The founder's leaf in the approved-member group. */
    semaphoreCommitment: bigint
    /** The founder's credential signing key, published into ApprovedIssuerSet at genesis. */
    credentialPublicKey: EddsaPublicKey
}

export interface GovernanceDeployment {
    safe: ContractDeployment
    registry: ContractDeployment
    group: ContractDeployment
    governance: ContractDeployment
    issuerSet: ContractDeployment
    groupId: bigint
    /** The block the governance contracts were deployed at, so later candidates' join requests can be
     * read `fromBlock` this without scanning genesis. */
    deployBlock: bigint
    context: SafeContext & { safeVersion: SafeVersion }
}

function accountKeyCoordinates(founder: GovernanceFounder): [bigint, bigint] {
    const { accountKeyX, accountKeyY } = memberAccountKey(privateKeyToAccount(founder.authPrivateKey).publicKey)

    return [accountKeyX, accountKeyY]
}

async function deploySafe(
    anvil: DedicatedAnvil,
    owners: Address[]
): Promise<{ safe: ContractDeployment; multiSend: Address; version: SafeVersion }> {
    const singleton = await deployContract(anvil, readArtifact(CONTRACTS_DIR, "out/Safe.sol/Safe.json"))
    const factory = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/SafeProxyFactory.sol/SafeProxyFactory.json")
    )
    const multiSend = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/MultiSendCallOnly.sol/MultiSendCallOnly.json")
    )

    const version = (await anvil.publicClient.readContract({
        address: singleton.address,
        abi: singleton.abi,
        functionName: "VERSION"
    })) as SafeVersion

    // Bootstrapped at threshold 1 so one founder can execute the genesis transactions alone; the
    // last of those raises it to what `governanceThreshold` says a Safe of this many owners needs.
    const initializer = encodeFunctionData({
        abi: singleton.abi,
        functionName: "setup",
        args: [owners, 1n, zeroAddress, "0x", zeroAddress, zeroAddress, 0n, zeroAddress]
    })
    const proxyHash = await anvil.walletClient.sendTransaction({
        account: anvil.deployer,
        chain: TESTBED_CHAIN,
        to: factory.address,
        data: encodeFunctionData({
            abi: factory.abi,
            functionName: "createProxyWithNonce",
            args: [singleton.address, initializer, 0n]
        })
    })
    const proxyReceipt = await anvil.publicClient.waitForTransactionReceipt({ hash: proxyHash })

    for (const log of proxyReceipt.logs) {
        if (!isAddressEqual(log.address, factory.address)) continue

        const { args } = decodeEventLog({
            abi: PROXY_CREATION_ABI,
            eventName: "ProxyCreation",
            data: log.data,
            topics: log.topics
        })
        return { safe: { abi: singleton.abi, address: getAddress(args.proxy) }, multiSend: multiSend.address, version }
    }

    throw new Error("Safe proxy deployment emitted no ProxyCreation event")
}

/**
 * Founds the network: a Safe owned by `founders`' governance signers, the three governance
 * contracts, the issuer set wired to the registry, and the founders admitted in a genesis
 * transaction that goes straight to the registry and the group rather than through the
 * orchestrator (their governance signers are already owners, so `admitMember` would add them a
 * second time). Matches `apps/registry-demo/scripts/deploy/network-member.ts`.
 *
 * The Safe is bootstrapped at threshold 1 and left at {governanceThreshold} of the owner count, so
 * admitting the next candidate takes a majority of the founders rather than any one of them.
 */
export async function deployGovernanceStack(
    anvil: DedicatedAnvil,
    semaphore: SemaphoreDeployment,
    founders: GovernanceFounder[],
    diagnostic: (message: string) => void = () => {}
): Promise<GovernanceDeployment> {
    buildContracts(CONTRACTS_DIR)

    const deployBlock = await anvil.publicClient.getBlockNumber()

    const owners = founders.map((founder) => privateKeyToAccount(founder.governanceSignerPrivateKey).address)
    const { safe, multiSend, version } = await deploySafe(anvil, owners)

    const registry = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/NetworkMemberRegistry.sol/NetworkMemberRegistry.json"),
        [safe.address]
    )
    const group = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/NetworkMemberGroup.sol/NetworkMemberGroup.json"),
        [semaphore.semaphore.address, safe.address]
    )
    const governance = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/NetworkMemberGovernance.sol/NetworkMemberGovernance.json"),
        [safe.address, registry.address, group.address]
    )
    const issuerSet = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/ApprovedIssuerSet.sol/ApprovedIssuerSet.json"),
        [registry.address]
    )

    const groupId = (await anvil.publicClient.readContract({
        address: group.address,
        abi: group.abi,
        functionName: "GROUP_ID"
    })) as bigint

    const context: GovernanceDeployment["context"] = {
        safeAddress: safe.address,
        chainId: TESTBED_CHAIN.id,
        safeVersion: version,
        multiSend
    }

    // Still at threshold 1: each of these transactions is executed by the first founder alone, and
    // the Safe treats the executor as approved without a prior `approveHash`.
    const executor = privateKeyToAccount(founders[0].governanceSignerPrivateKey)
    let nonce = 0
    const execute = async (calls: MetaTransactionData[]) => {
        const transaction = buildSafeTransactionData(calls, context, nonce)
        nonce += 1

        const safeTxHash = hashSafeTransaction(context, transaction)
        const onChainHash = await anvil.publicClient.readContract({
            address: safe.address,
            abi: safe.abi,
            functionName: "getTransactionHash",
            args: [
                transaction.to,
                BigInt(transaction.value),
                transaction.data,
                transaction.operation,
                BigInt(transaction.safeTxGas),
                BigInt(transaction.baseGas),
                BigInt(transaction.gasPrice),
                transaction.gasToken,
                transaction.refundReceiver,
                BigInt(transaction.nonce)
            ]
        })
        // Turns a Safe-version or encoding mismatch into a clear failure here, rather than the
        // Safe's opaque GS026 at execution.
        if (onChainHash !== safeTxHash) {
            throw new Error(`safeTxHash ${safeTxHash} does not match the Safe's own ${onChainHash}`)
        }

        const hash = await anvil.walletClient.sendTransaction({
            account: executor,
            chain: TESTBED_CHAIN,
            to: context.safeAddress,
            data: encodeExecTransaction(context, transaction, [onChainApproval(executor.address)])
        })
        await anvil.publicClient.waitForTransactionReceipt({ hash })
    }

    await execute([
        {
            to: registry.address,
            value: "0",
            data: encodeFunctionData({
                abi: registry.abi,
                functionName: "setApprovedIssuerSet",
                args: [issuerSet.address]
            })
        }
    ])
    await execute([
        {
            to: safe.address,
            value: "0",
            data: encodeFunctionData({ abi: safe.abi, functionName: "enableModule", args: [governance.address] })
        }
    ])
    await execute(
        founders.flatMap((founder) => [
            {
                to: registry.address,
                value: "0",
                data: encodeFunctionData({
                    abi: registry.abi,
                    functionName: "approveNetworkMember",
                    args: [
                        ...accountKeyCoordinates(founder),
                        founder.semaphoreCommitment,
                        privateKeyToAccount(founder.governanceSignerPrivateKey).address
                    ]
                })
            },
            {
                to: group.address,
                value: "0",
                data: encodeFunctionData({
                    abi: group.abi,
                    functionName: "addNetworkMember",
                    args: [founder.semaphoreCommitment]
                })
            }
        ])
    )

    // Last, so every transaction above still needed only the one signature, and the network is left
    // governed by its own rule rather than by the bootstrap.
    const threshold = governanceThreshold(owners.length)
    await execute([
        {
            to: safe.address,
            value: "0",
            data: encodeFunctionData({ abi: safe.abi, functionName: "changeThreshold", args: [BigInt(threshold)] })
        }
    ])

    const liveThreshold = await anvil.publicClient.readContract({
        address: safe.address,
        abi: safe.abi,
        functionName: "getThreshold"
    })
    if (liveThreshold !== BigInt(threshold)) {
        throw new Error(`Safe threshold is ${liveThreshold}, expected ${threshold} for ${owners.length} owner(s)`)
    }

    for (const founder of founders) {
        const authAccount = privateKeyToAccount(founder.authPrivateKey)
        const hash = await anvil.walletClient.sendTransaction({
            account: authAccount,
            chain: TESTBED_CHAIN,
            to: issuerSet.address,
            data: encodeFunctionData({
                abi: issuerSet.abi,
                functionName: "publishIssuerKey",
                args: [founder.networkId, founder.credentialPublicKey[0], founder.credentialPublicKey[1]]
            })
        })
        await anvil.publicClient.waitForTransactionReceipt({ hash })
    }

    diagnostic(`Governance Safe ${safe.address}; ${founders.length} founder(s), threshold ${threshold}`)
    diagnostic(`NetworkMemberRegistry ${registry.address}; NetworkMemberGroup ${group.address} (group ${groupId})`)
    diagnostic(`NetworkMemberGovernance ${governance.address}; ApprovedIssuerSet ${issuerSet.address}`)

    return { safe, registry, group, governance, issuerSet, groupId, deployBlock, context }
}
