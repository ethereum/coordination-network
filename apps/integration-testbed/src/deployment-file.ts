import { readFileSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import { Address, getAddress } from "viem"
import { CONTRACTS_DIR, REPOSITORY_ROOT } from "./config"

export interface DeployedContracts {
    blockNumber: bigint
    chainId: number
    governanceSafe: Address
    networkMemberGovernance: Address
    networkMemberGroup: Address
    networkMemberGroupId: bigint
    networkMemberRegistry: Address
    identityRegistry: Address
    approvedIssuerSet: Address
    semaphorePaymaster: Address
    revocation: Address
    credentialRevocationRegistry: Address
    credentialRevocationRegistryId: bigint
}

export function deploymentFilePath(chainId: number): string {
    return join(CONTRACTS_DIR, "deployments", `${chainId}.json`)
}

/** `yarn stack:*` runs from the app's directory, so a relative `DEPLOYMENT_FILE` means the repository root. */
export function deploymentFileFor(setting: string | undefined, chainId: number): string {
    if (setting === undefined || setting === "") return deploymentFilePath(chainId)
    return isAbsolute(setting) ? setting : resolve(REPOSITORY_ROOT, setting)
}

export function readDeploymentFile(path: string): DeployedContracts {
    const deploymentFileJson = readFileSync(path, "utf8")
    const deployed = JSON.parse(deploymentFileJson) as Record<string, string | number>

    return {
        blockNumber: BigInt(deployed.blockNumber),
        chainId: Number(deployed.chainId),
        governanceSafe: getAddress(String(deployed.governanceSafe)),
        networkMemberGovernance: getAddress(String(deployed.networkMemberGovernance)),
        networkMemberGroup: getAddress(String(deployed.networkMemberGroup)),
        networkMemberGroupId: BigInt(deployed.networkMemberGroupId),
        networkMemberRegistry: getAddress(String(deployed.networkMemberRegistry)),
        identityRegistry: getAddress(String(deployed.identityRegistry)),
        approvedIssuerSet: getAddress(String(deployed.approvedIssuerSet)),
        semaphorePaymaster: getAddress(String(deployed.semaphorePaymaster)),
        revocation: getAddress(String(deployed.revocation)),
        credentialRevocationRegistry: getAddress(String(deployed.credentialRevocationRegistry)),
        credentialRevocationRegistryId: BigInt(deployed.credentialRevocationRegistryId)
    }
}
