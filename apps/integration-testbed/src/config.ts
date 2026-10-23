import { join } from "node:path"
import { Address, parseEther } from "viem"
import { foundry } from "viem/chains"
import { credentialArtifactPath } from "@coordination-network/zk-artifacts"

export const REPOSITORY_ROOT = join(__dirname, "../../..")
export const CONTRACTS_DIR = join(REPOSITORY_ROOT, "packages/contracts")
export const CREDENTIAL_CIRCUIT_PATH = credentialArtifactPath("circuit.json")

export const TESTBED_CHAIN = {
    ...foundry,
    id: 1337,
    name: "Coordination Network Integration Testbed"
} as const

export const REVOCATION_REGISTRY_ID = 0n

export const MNEMONIC = "test test test test test test test test test test test junk"
// Indexes 0 to 11 represent defined roles from the registry demo — defined
// in `scripts/shared/config.ts`. indexes 12 and 13 are Alto's executor and
// utility wallets used in this testbed.
export const PREFUND_ACCOUNT_COUNT = 14
export const PREFUND_AMOUNT = parseEther("1000")

// Required addresses from `script/libraries/DeployedThirdPartyContracts.sol` pins.
export const ERC5564_ANNOUNCER_ADDRESS: Address = "0x55649E01B5Df198D18D95b5cc5051630cfD45564"
export const SEMAPHORE_ADDRESS: Address = "0xC10E5102A2Cc077BE3B9740Fc0Ad7e27Ff8E0245"
export const SIMPLE_7702_ACCOUNT_ADDRESS: Address = "0xe6Cae83BdE06E4c305530e199D7217f42808555B"
