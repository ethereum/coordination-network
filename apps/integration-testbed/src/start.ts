import { spawnSync } from "node:child_process"

const arguments_ = process.argv.slice(2)
const unknownArguments = arguments_.filter((argument) => argument !== "--minimal")
if (unknownArguments.length > 0) {
    throw new Error(`unknown integration-testbed option: ${unknownArguments.join(", ")}`)
}

const mode = arguments_.includes("--minimal") ? "minimal" : "multi-user"
process.stdout.write(`Running ${mode} local integration\n\n`)

const result = spawnSync("yarn", ["test:scenario"], {
    env: { ...process.env, TESTBED_MODE: mode },
    stdio: "inherit"
})

if (result.error) throw result.error
if (result.signal) throw new Error(`integration scenario terminated by ${result.signal}`)
process.exitCode = result.status ?? 1
