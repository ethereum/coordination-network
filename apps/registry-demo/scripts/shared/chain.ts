import { spawn, type ChildProcess } from "node:child_process"
import { publicClient, RPC_URL } from "./config.ts"

/**
 * Starts a throwaway Anvil for one run of the demo, on the demo's own port.
 *
 * One flow at a time: the port is fixed, so two walkthroughs cannot run at once and the test script
 * runs its files serially.
 *
 * Refuses to continue if that Anvil is not the one answering. When the port is already taken, Anvil
 * exits immediately and the node already there answers instead: the demo would deploy onto whatever
 * state that node had accumulated, and the process it later kills would be one that was never running.
 * That failure is silent, and the run still prints a clean success, so it is checked rather than
 * assumed.
 */
export async function startAnvil(): Promise<ChildProcess> {
    const port = new URL(RPC_URL).port

    // More than Anvil's default ten: every member holds two keys, and there are five members.
    const anvil = spawn("anvil", ["--port", port, "--accounts", "12"], { stdio: "ignore" })

    let startupFailure: Error | undefined
    anvil.once("error", (error) => {
        startupFailure = error
    })
    anvil.once("exit", (code) => {
        startupFailure ??= new Error(`anvil exited with code ${code}`)
    })

    for (let attempt = 0; attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100))

        if (startupFailure) {
            throw new Error(
                `anvil could not start on port ${port}: ${startupFailure.message}. ` +
                    "Another process is probably holding it, possibly a node left over from an earlier run"
            )
        }

        try {
            await publicClient.getBlockNumber()
            return anvil
        } catch {
            // Not listening yet.
        }
    }

    anvil.kill()
    throw new Error(`anvil did not start on ${RPC_URL}. Is Foundry installed?`)
}

/**
 * Moves the local chain's clock forward.
 *
 * Semaphore accepts a superseded group root for a while after it stops being current, so showing that
 * window close means waiting an hour of chain time.
 */
export async function advanceTime(seconds: bigint) {
    const anvilRpc = publicClient as unknown as {
        request(args: { method: string; params: unknown[] }): Promise<unknown>
    }

    await anvilRpc.request({ method: "evm_increaseTime", params: [Number(seconds)] })
    await anvilRpc.request({ method: "evm_mine", params: [] })
}
