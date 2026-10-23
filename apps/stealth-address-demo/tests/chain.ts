import { spawn, type ChildProcess } from "node:child_process"
import { publicClient, RPC_URL } from "../scripts/config.ts"

export async function startAnvil(): Promise<ChildProcess> {
    const anvil = spawn("anvil", ["--port", new URL(RPC_URL).port], { stdio: "ignore" })
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            await publicClient.getBlockNumber()
            return anvil
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 100))
        }
    }
    throw new Error(`anvil did not start on ${RPC_URL}`)
}
