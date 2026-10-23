import { readFileSync } from "node:fs"
import { join } from "node:path"
import { publicClient, walletClient } from "./config.ts"

const CONTRACTS_OUT_DIR = join(__dirname, "../../../packages/contracts/out")

/** Deploys the ERC-5564 announcer the sender announces payments on. */
export async function deployAnnouncer() {
    const artifact = JSON.parse(
        readFileSync(join(CONTRACTS_OUT_DIR, "ERC5564Announcer.sol", "ERC5564Announcer.json"), "utf8")
    )
    const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object })
    const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash })

    if (!contractAddress) throw new Error("announcer deployment returned no contract address")
    return contractAddress
}

/** Deploys the mock scoped token the sender mints to stealth accounts. */
export async function deployToken() {
    const artifact = JSON.parse(
        readFileSync(join(CONTRACTS_OUT_DIR, "TestScopedToken.sol", "TestScopedToken.json"), "utf8")
    )
    const hash = await walletClient.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object })
    const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash })

    if (!contractAddress) throw new Error("token deployment returned no contract address")
    return contractAddress
}
