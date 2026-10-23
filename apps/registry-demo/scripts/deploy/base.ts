import { decodeEventLog, encodeFunctionData, zeroAddress, type Address } from "viem"
import { governanceThreshold, type SafeContext } from "@coordination-network/network-member-governance"
import { SAFE_ABI, SAFE_PROXY_FACTORY_ABI } from "../shared/abis.ts"
import { deploy, deployLibrary } from "../shared/artifacts.ts"
import { POSEIDON_T3, POSEIDON_T4, publicClient, roles, send } from "../shared/config.ts"
import { founders } from "../shared/personas.ts"

/** The Safe contracts in this repo are 1.5.0, so every digest must be computed for that version. */
const SAFE_VERSION = "1.5.0" as const

/**
 * What every flow needs before any registry exists: Semaphore, and a governance Safe to own the
 * contracts. Kept apart so each flow deploys it once and then adds only what it is about.
 */
export interface BaseDeployment {
    /** The Semaphore deployment groups are created on. */
    semaphore: Address
    /** The governance Safe: the approver set, and the owner of everything the flows deploy. */
    safe: Address
    /** The Safe and chain every governance transaction is bound to. */
    context: SafeContext
}

/**
 * Deploys Semaphore and the governance Safe, the latter owned by the founding members at the threshold
 * `governanceThreshold` gives. That is the same expression the orchestrator computes on chain, so the
 * founding Safe starts under the rule every later operation applies.
 */
export async function deployBase(): Promise<BaseDeployment> {
    await deployLibrary("PoseidonT3", POSEIDON_T3)
    await deployLibrary("PoseidonT4", POSEIDON_T4)

    const verifier = await deploy("SemaphoreVerifier")
    const semaphore = await deploy("Semaphore", [verifier])
    const safe = await deployGovernanceSafe()

    // A batched Safe transaction delegate-calls MultiSendCallOnly, and chain 31337 has no canonical
    // deployment for the governance package to resolve, so the genesis batch gets this one.
    const multiSend = await deploy("MultiSendCallOnly")

    return {
        semaphore,
        safe,
        context: { safeAddress: safe, chainId: publicClient.chain.id, safeVersion: SAFE_VERSION, multiSend }
    }
}

/** A majority of the founding members, signing with their governance signers. */
export function foundingQuorum() {
    return founders.slice(0, governanceThreshold(founders.length)).map((founder) => founder.governanceSigner)
}

async function deployGovernanceSafe(): Promise<Address> {
    const singleton = await deploy("Safe")
    const factory = await deploy("SafeProxyFactory")

    const owners = founders.map((founder) => founder.governanceSigner.address)

    const initializer = encodeFunctionData({
        abi: SAFE_ABI,
        functionName: "setup",
        args: [
            owners,
            BigInt(governanceThreshold(owners.length)),
            zeroAddress,
            "0x",
            zeroAddress,
            zeroAddress,
            0n,
            zeroAddress
        ]
    })

    const receipt = await send({
        account: roles.deployer,
        to: factory,
        data: encodeFunctionData({
            abi: SAFE_PROXY_FACTORY_ABI,
            functionName: "createProxyWithNonce",
            args: [singleton, initializer, 0n]
        })
    })

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== factory.toLowerCase()) continue

        const { args } = decodeEventLog({
            abi: SAFE_PROXY_FACTORY_ABI,
            eventName: "ProxyCreation",
            data: log.data,
            topics: log.topics
        })

        return args.proxy
    }

    throw new Error("Safe proxy deployment emitted no ProxyCreation event")
}
