import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * Rebuilds the credential circuit and writes its publishable artifacts into
 * this package. They are committed because the release workflow publishes with
 * Node alone: it has neither nargo nor bb to regenerate them.
 *
 * Run this, and commit the result, whenever the circuit or the toolchain changes.
 */

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)))
const packagesDir = dirname(packageDir)
const repositoryRoot = dirname(packagesDir)
const circuitsDir = join(packagesDir, "circuits")
const destination = join(packageDir, "credential")

const ARTIFACTS = ["circuit.json", "vk"] as const

const run = (command: string, args: string[], capture = false) => {
    const result = spawnSync(command, args, { cwd: circuitsDir, stdio: capture ? "pipe" : "inherit" })
    if (result.error) {
        throw new Error(`could not run ${command}: see packages/circuits/README.md for the pinned toolchain`)
    }
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with ${result.status}`)
    return result.stdout?.toString().trim() ?? ""
}

const pinnedVersion = (dependency: string): string => {
    const manifest = JSON.parse(readFileSync(join(packagesDir, "credential/package.json"), "utf8"))
    const version = manifest.dependencies?.[dependency]
    if (typeof version !== "string") throw new Error(`@coordination-network/credential does not pin ${dependency}`)
    return version
}

// A circuit compiled by one toolchain and proved by another fails deep inside
// barretenberg's deserializer, so refuse to ship a mismatched pair.
const assertMatchesRuntimePin = (dependency: string, actual: string, tool: string) => {
    const expected = pinnedVersion(dependency)
    if (!actual.startsWith(expected)) {
        throw new Error(`${tool} is ${actual}, but @coordination-network/credential pins ${dependency}@${expected}`)
    }
}

// nargo records where it found each source file, so a straight copy would publish
// the maintainer's home directory and change the artifact from machine to machine.
// Rewriting those roots keeps the debug call stacks intact and makes the artifact
// reproducible; the stdlib's own `std/...` paths are already relative.
const dependencyRoots = [
    ...new Set(
        [repositoryRoot, process.env.NARGO_HOME, join(homedir(), "nargo"), join(homedir(), ".nargo")].filter(
            (root): root is string => Boolean(root)
        )
    )
].sort((a, b) => b.length - a.length)

const portablePath = (path: string): string => {
    for (const root of dependencyRoots) {
        if (path === root || path.startsWith(root + sep)) return relative(root, path).split(sep).join("/")
    }
    return path
}

// bb's own version is the only record of which barretenberg built the key, so check it
// before doing the work rather than discovering the mismatch at proving time.
assertMatchesRuntimePin("@aztec/bb.js", run("bb", ["--version"], true).replace(/^v/, ""), "bb")

// Without --force, nargo keeps a cached artifact whenever the program is semantically
// unchanged, so a comment-only edit would be copied over as the previous build.
run("nargo", ["compile", "--force"])

const compiled = join(circuitsDir, "target/credential.json")
const circuit = JSON.parse(readFileSync(compiled, "utf8"))
assertMatchesRuntimePin("@noir-lang/noir_js", circuit.noir_version, "the compiled circuit's nargo")

for (const entry of Object.values(circuit.file_map) as Array<{ path: string }>) {
    entry.path = portablePath(entry.path)
}

const remaining = (Object.values(circuit.file_map) as Array<{ path: string }>).filter((entry) =>
    entry.path.startsWith("/")
)
if (remaining.length > 0) {
    throw new Error(`absolute paths left in the circuit's file map: ${remaining.map((e) => e.path).join(", ")}`)
}

// The circuit and its key have to move as a pair: a bb that fails halfway would otherwise
// leave a freshly compiled circuit beside the key of the previous one, which nothing
// downstream would notice. Build both somewhere else, then put them in place together.
const staging = mkdtempSync(join(tmpdir(), "zk-artifacts-"))

try {
    // nargo emits compact JSON; keep that so the committed artifact stays diffable by size alone.
    writeFileSync(join(staging, "circuit.json"), JSON.stringify(circuit))

    // bb names its own binary output `vk`, and drops a `vk_hash` beside it that nothing
    // consumes; leaving the hash in staging is how it gets discarded.
    run("bb", ["write_vk", "-b", compiled, "-o", staging])

    mkdirSync(destination, { recursive: true })
    for (const name of ARTIFACTS) {
        copyFileSync(join(staging, name), join(destination, name))
    }
} finally {
    rmSync(staging, { recursive: true, force: true })
}

for (const name of ARTIFACTS) {
    console.info(`wrote credential/${name} (${statSync(join(destination, name)).size} bytes)`)
}
console.info(`circuit noir_version ${circuit.noir_version}`)
