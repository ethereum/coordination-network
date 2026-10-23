import { execFileSync, spawn } from "node:child_process"
import { http, toHex } from "viem"
import { createBundlerClient, entryPoint08Address } from "viem/account-abstraction"
import { mnemonicToAccount } from "viem/accounts"
import { Chain, freePort, requiredEnvironmentVariable, waitForNetwork } from "./anvil"
import { MNEMONIC } from "./config"

// Alto is pinned to v1.2.5. From v1.2.6, with safe mode on, `eth_sendUserOperation` fails for every UserOperation
// sent to EntryPoint v0.8. Before accepting an operation, Alto simulates it and records a validation trace: the
// list of every contract call the simulation made and what each returned. Alto reads the result from the wrong call
// frame (the wrong entry in that list) and cannot decode it.
// TODO: move to latest once https://github.com/pimlicolabs/alto/issues/756 is fixed (TLDR: safe mode broken from v1.2.6)
const ALTO_IMAGE = "ghcr.io/pimlicolabs/alto:v1.2.5"
const ALTO_PORT = 3000
// Alto's two wallets. The executor signs and pays for the handleOps
// bundles Alto sends to geth. The utility wallet deploys Alto's simulation
// contracts at startup and tops up the executor.
const EXECUTOR_PRIVATE_KEY = toHex(mnemonicToAccount(MNEMONIC, { addressIndex: 12 }).getHdKey().privateKey!)
const UTILITY_PRIVATE_KEY = toHex(mnemonicToAccount(MNEMONIC, { addressIndex: 13 }).getHdKey().privateKey!)

export interface TestbedBundler {
    rpcUrl: string
    stop(): void
}

export function connectToBundler(diagnostic: (message: string) => void = () => {}): TestbedBundler {
    const rpcUrl = requiredEnvironmentVariable("BUNDLER_URL")

    diagnostic(`Bundler ${new URL(rpcUrl).host}; EntryPoint ${entryPoint08Address}`)

    return { rpcUrl, stop: () => {} }
}

export async function startBundler(
    chain: Chain,
    diagnostic: (message: string) => void = () => {}
): Promise<TestbedBundler> {
    const port = await freePort()
    const rpcUrl = `http://127.0.0.1:${port}`
    const containerId = execFileSync(
        "docker",
        [
            "run",
            "--detach",
            "--add-host",
            "host.docker.internal:host-gateway",
            "--publish",
            `${port}:${ALTO_PORT}`,
            ALTO_IMAGE,
            "--entrypoints",
            entryPoint08Address,
            "--rpc-url",
            chain.rpcUrl.replace("127.0.0.1", "host.docker.internal"),
            "--executor-private-keys",
            EXECUTOR_PRIVATE_KEY,
            "--utility-private-key",
            UTILITY_PRIVATE_KEY
        ],
        { encoding: "utf8" }
    ).trim()
    const stop = () => void spawn("docker", ["rm", "--force", containerId], { detached: true, stdio: "ignore" }).unref()
    const bundlerClient = createBundlerClient({ transport: http(rpcUrl, { retryCount: 0 }) })

    try {
        await waitForNetwork(() => bundlerClient.getSupportedEntryPoints(), `bundler did not start on ${rpcUrl}`)

        diagnostic(`Bundler ${ALTO_IMAGE} at ${rpcUrl}`)
        return { rpcUrl, stop }
    } catch (error) {
        execFileSync("docker", ["logs", containerId], { stdio: "inherit" })
        stop()
        throw error
    }
}
