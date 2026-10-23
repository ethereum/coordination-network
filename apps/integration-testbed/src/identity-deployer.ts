import { DedicatedAnvil } from "./anvil"
import { CONTRACTS_DIR } from "./config"
import { buildContracts, ContractDeployment, deployContract, readArtifact } from "./deployer"

export interface SemaphoreDeployment {
    verifier: ContractDeployment
    semaphore: ContractDeployment
}

/** Deploys Semaphore, gating none of it: the approved-member group is created by NetworkMemberGroup. */
export async function deploySemaphore(
    anvil: DedicatedAnvil,
    diagnostic: (message: string) => void = () => {}
): Promise<SemaphoreDeployment> {
    buildContracts(CONTRACTS_DIR)

    const verifier = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/SemaphoreVerifier.sol/SemaphoreVerifier.json")
    )
    const semaphore = await deployContract(anvil, readArtifact(CONTRACTS_DIR, "out/Semaphore.sol/Semaphore.json"), [
        verifier.address
    ])

    diagnostic(`Semaphore ${semaphore.address}`)

    return { verifier, semaphore }
}

export interface IdentityDeployment {
    registry: ContractDeployment
}

/**
 * Deploys the IdentityRegistry gated on `groupId`, the approved-network-member group
 * `governance-deployer.ts`'s NetworkMemberGroup created. Every write proof is checked against that
 * group, so the registry has no group of its own to create.
 */
export async function deployIdentityRegistry(
    anvil: DedicatedAnvil,
    semaphore: SemaphoreDeployment,
    groupId: bigint,
    diagnostic: (message: string) => void = () => {}
): Promise<IdentityDeployment> {
    buildContracts(CONTRACTS_DIR)

    const registry = await deployContract(
        anvil,
        readArtifact(CONTRACTS_DIR, "out/IdentityRegistry.sol/IdentityRegistry.json"),
        [semaphore.semaphore.address, groupId]
    )

    diagnostic(`IdentityRegistry ${registry.address}`)

    return { registry }
}
