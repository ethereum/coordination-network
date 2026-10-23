import { randomBytes } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startLinkRelay } from "./link-relay"

async function main() {
    const host = process.env.LINK_RELAY_HOST ?? "127.0.0.1"
    const port = Number(process.env.LINK_RELAY_PORT ?? 4177)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid relay port")
    const defaults = ["localhost", "127.0.0.1"].flatMap((host) =>
        [4173, 4174, 4175, 4176].map((port) => `http://${host}:${port}`)
    )
    const origins =
        process.env.LINK_RELAY_ORIGINS?.split(",").map((origin) => new URL(origin.trim()).origin) ?? defaults
    const token = randomBytes(32).toString("hex")
    const directory = mkdtempSync(join(tmpdir(), "coordination-link-relay-"))
    const path = join(directory, "session-key.txt")
    writeFileSync(path, `${token}\n`, { mode: 0o600 })
    let server
    try {
        server = await startLinkRelay(port, origins, { token, host })
    } catch (error) {
        rmSync(directory, { recursive: true, force: true })
        throw error
    }
    process.once("exit", () => rmSync(directory, { recursive: true, force: true }))
    console.info(`Link relay: http://${host}:${port}`)
    console.info(`Demo connection key: ${path} (operator only; deleted when the relay stops)`)
    const stop = () => {
        server.close()
        server.closeAllConnections()
        rmSync(directory, { recursive: true, force: true })
    }
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.once(signal, stop)
}

main().catch((error) => {
    console.error(error)
    process.exitCode = 1
})
