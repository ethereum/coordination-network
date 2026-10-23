import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createTestClient, http, type Abi, type Address, type Hex } from "viem"
import { DEMO_CHAIN, publicClient, roles, RPC_URL, walletClient } from "./config.ts"
import { foundry } from "viem/chains"

/**
 * Where Forge writes the compiled contracts.
 *
 * Found by walking up to the workspace root rather than by counting directories, so moving a file
 * inside this app cannot silently break it.
 */
const CONTRACTS_OUT_DIR = join(workspaceRoot(), "packages/contracts/out")

function workspaceRoot(): string {
    let directory = __dirname

    while (!existsSync(join(directory, "yarn.lock"))) {
        const parent = dirname(directory)
        if (parent === directory) throw new Error("could not find the workspace root above " + __dirname)
        directory = parent
    }

    return directory
}

interface ForgeArtifact {
    abi: Abi
    bytecode: {
        object: Hex
        linkReferences: Record<string, Record<string, Array<{ start: number; length: number }>>>
    }
}

/** Reads a Forge artifact. A stale `out` directory shows up here as a missing file. */
function readArtifact(contract: string): ForgeArtifact {
    const path = join(CONTRACTS_OUT_DIR, `${contract}.sol`, `${contract}.json`)

    try {
        return JSON.parse(readFileSync(path, "utf8")) as ForgeArtifact
    } catch {
        throw new Error(`missing artifact for ${contract}. Run \`yarn build:contracts\` from the repo root`)
    }
}

export async function deployLibrary(contract: string, canonicalAddress: Address): Promise<void> {
    const deployedAddress = await deploy(contract)
    const deployedCode = await publicClient.getBytecode({ address: deployedAddress })
    if (!deployedCode) throw new Error(`deployed ${contract} has no runtime bytecode`)

    const testClient = createTestClient({ chain: foundry, mode: "anvil", transport: http(RPC_URL) })
    await testClient.setCode({ address: canonicalAddress, bytecode: deployedCode })
}

/** Deploys a contract from its Forge artifact. */
export async function deploy(contract: string, args: readonly unknown[] = []): Promise<Address> {
    const artifact = readArtifact(contract)

    const hash = await walletClient.deployContract({
        abi: artifact.abi,
        bytecode: artifact.bytecode.object,
        args: args as never,
        account: roles.deployer,
        chain: DEMO_CHAIN
    })
    const { contractAddress } = await publicClient.waitForTransactionReceipt({ hash })

    if (!contractAddress) throw new Error(`${contract} deployment returned no address`)

    return contractAddress
}
