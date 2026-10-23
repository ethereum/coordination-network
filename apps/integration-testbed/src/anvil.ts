import { ChildProcess, spawn } from "node:child_process"
import { createServer } from "node:net"
import {
    Account,
    Address,
    Chain as ViemChain,
    Hex,
    createPublicClient,
    createWalletClient,
    defineChain,
    formatEther,
    http,
    nonceManager,
    PublicClient,
    WalletClient
} from "viem"
import { privateKeyToAccount } from "viem/accounts"
import { TESTBED_CHAIN } from "./config"
import { OperatorError } from "./operator-error"

const PUBLIC_CHAIN_BLOCK_SCAN_WINDOW_SIZE = 10n
const LOCAL_CHAIN_BLOCK_SCAN_WINDOW_SIZE = 100n

export interface Chain {
    chainDefinition: ViemChain
    deployer: Address
    signer: Address | Account
    publicClient: PublicClient
    rpcUrl: string
    blockScanWindowSize: bigint
    stop(): void
    walletClient: WalletClient
}

export interface DedicatedAnvil extends Chain {
    process: ChildProcess
}

export function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer()
        server.once("error", reject)
        server.listen(0, "127.0.0.1", () => {
            const address = server.address()
            if (!address || typeof address === "string") {
                server.close()
                reject(new Error("could not allocate a local port"))
                return
            }
            server.close((error) => (error ? reject(error) : resolve(address.port)))
        })
    })
}

async function waitForRpc(client: PublicClient): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            await client.getChainId()
            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    throw new Error("dedicated Anvil did not start")
}

export function requiredEnvironmentVariable(name: string): string {
    const value = process.env[name]
    if (!value) throw new OperatorError(`${name} must be set to run against a public network`)

    return value
}

/** The variable's value, or undefined when it is unset or blank: an empty `VAR=` line means "use the default". */
export function optionalEnvironmentVariable(name: string): string | undefined {
    const value = process.env[name]
    return value === undefined || value.trim() === "" ? undefined : value
}

export async function connectToChain(diagnostic: (message: string) => void = () => {}): Promise<Chain> {
    const rpcUrl = requiredEnvironmentVariable("RPC_URL")
    if (!/^https?:\/\//i.test(rpcUrl) || !URL.canParse(rpcUrl)) {
        throw new OperatorError("RPC_URL must be an http(s) URL")
    }
    // Neither check echoes the value: a malformed key or URL is still the operator's secret.
    const ownerKey = requiredEnvironmentVariable("OWNER_PRIVATE_KEY")
    if (!/^0x[0-9a-fA-F]{64}$/.test(ownerKey)) {
        throw new OperatorError("OWNER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key")
    }
    const account = privateKeyToAccount(ownerKey as Hex, { nonceManager })
    const chainId = await createPublicClient({ transport: http(rpcUrl) }).getChainId()
    const chainDefinition = defineChain({
        id: chainId,
        name: `chain ${chainId}`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } }
    })
    const publicClient = createPublicClient({ chain: chainDefinition, transport: http(rpcUrl) })
    const walletClient = createWalletClient({ account, chain: chainDefinition, transport: http(rpcUrl) })
    const balance = await publicClient.getBalance({ address: account.address })

    diagnostic(
        `RPC ${new URL(rpcUrl).origin}; chain ${chainId}; sender ${account.address} holding ${formatEther(balance)} ETH`
    )

    return {
        chainDefinition,
        deployer: account.address,
        signer: account,
        publicClient,
        rpcUrl,
        blockScanWindowSize: PUBLIC_CHAIN_BLOCK_SCAN_WINDOW_SIZE,
        stop: () => {},
        walletClient
    }
}

export interface StartDedicatedAnvilOptions {
    /** Bind address for anvil's own `--host` flag. Defaults to anvil's own default, 127.0.0.1. */
    host?: string
    /** Fixed port instead of an OS-allocated free one. */
    port?: number
}

export async function startDedicatedAnvil(
    diagnostic: (message: string) => void = () => {},
    { host, port: fixedPort }: StartDedicatedAnvilOptions = {}
): Promise<DedicatedAnvil> {
    const port = fixedPort ?? (await freePort())
    const rpcUrl = `http://127.0.0.1:${port}`

    if (fixedPort !== undefined) {
        // A stray node already on this port would otherwise pass the readiness poll below,
        // running the stack against whatever that is instead of the anvil spawned here.
        let alreadyListening = true
        try {
            await createPublicClient({ transport: http(rpcUrl) }).getBlockNumber()
        } catch {
            alreadyListening = false
        }
        if (alreadyListening) {
            throw new Error(`something already listens on ${rpcUrl}; stop it before starting the stack`)
        }
    }

    const args = [
        "--port",
        String(port),
        "--chain-id",
        String(TESTBED_CHAIN.id),
        "--code-size-limit",
        "1000000",
        // EntryPoint 0.8's 7702 delegation needs Prague; pinned rather than relying on anvil's default.
        "--hardfork",
        "prague",
        // Alto, which the scenario suite bundles through, funds itself from mnemonic accounts 12
        // and 13. Anvil's default ten would leave both empty and Alto never starts.
        "--accounts",
        "20",
        "--silent"
    ]
    if (host !== undefined) args.push("--host", host)
    const process = spawn("anvil", args, { stdio: "ignore" })
    const publicClient = createPublicClient({ chain: TESTBED_CHAIN, transport: http(rpcUrl) })
    const walletClient = createWalletClient({ chain: TESTBED_CHAIN, transport: http(rpcUrl) })

    try {
        await waitForRpc(publicClient)
        const [deployer] = await walletClient.getAddresses()
        if (!deployer) throw new Error("dedicated Anvil exposed no unlocked deployer account")

        diagnostic(`RPC ${rpcUrl}; chain ${TESTBED_CHAIN.id}; deployer ${deployer}`)
        return {
            chainDefinition: TESTBED_CHAIN,
            signer: deployer,
            deployer,
            process,
            publicClient,
            rpcUrl,
            blockScanWindowSize: LOCAL_CHAIN_BLOCK_SCAN_WINDOW_SIZE,
            stop: () => process.kill(),
            walletClient
        }
    } catch (error) {
        process.kill()
        throw error
    }
}

/**
 * The web-demo files carried over from main name the chain `Chain` and start it with `startChain`.
 * That stack ran geth; this one runs anvil, which is a superset of what those files read.
 */
export type StartChainOptions = StartDedicatedAnvilOptions
export const startChain = startDedicatedAnvil

export async function waitForNetwork(check: () => Promise<unknown>, failureMessage: string): Promise<void> {
    for (let attempt = 0; attempt < 300; attempt += 1) {
        try {
            await check()
            return
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 200))
        }
    }
    throw new Error(failureMessage)
}
