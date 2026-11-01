// The reference apps must build from the published @coordination-network packages. A dependency
// that resolves into packages/ would silently build an app from source.
import { execFileSync } from "node:child_process"
import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, join, resolve, sep } from "node:path"
import ts from "typescript"

const APPS = ["user-app", "network-member-app", "user-web-app", "network-member-web-app"]
const SCOPE = "@coordination-network/"
const APP_UI = `${SCOPE}app-ui`

const packagesDir = realpathSync(resolve("packages"))

type Manifest = Record<"dependencies" | "devDependencies" | "peerDependencies", Record<string, string> | undefined>

const readManifest = (dir: string): Manifest => JSON.parse(readFileSync(join(dir, "package.json"), "utf8"))
const scoped = (deps: Record<string, string> = {}) => Object.keys(deps).filter((name) => name.startsWith(SCOPE))

// Walks up the way Node does. require.resolve("<name>/package.json") fails for packages that don't export it.
function installedDir(name: string, fromDir: string): string | undefined {
    for (let dir = fromDir; ; dir = dirname(dir)) {
        const candidate = join(dir, "node_modules", name)
        if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate)
        if (dir === dirname(dir)) return undefined
    }
}

// An undeclared import resolves through the root workspace symlink, back to source.
const SPECIFIER = /["'](@coordination-network\/[^/"']+)/g

const violations: string[] = []
let packageCount = 0

for (const app of APPS) {
    const appDir = realpathSync(resolve("apps", app))
    const manifest = readManifest(appDir)
    const seen = new Set<string>()
    const queue = scoped({ ...manifest.dependencies, ...manifest.devDependencies }).map((name) => ({
        name,
        fromDir: appDir,
        chain: app
    }))

    const declared = new Set(queue.map(({ name }) => name))
    const files = execFileSync("git", ["ls-files", join("apps", app)], { encoding: "utf8" }).split("\n")
    for (const file of files.filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file))) {
        for (const [, name] of readFileSync(file, "utf8").matchAll(SPECIFIER)) {
            if (!declared.has(name)) violations.push(`${app}: ${file} imports ${name}, not declared`)
        }
    }

    // Expo applies tsconfig paths to Metro, so a mapping into packages/ bundles source again.
    const tsconfig = ts.readConfigFile(join(appDir, "tsconfig.json"), ts.sys.readFile)
    const { paths = {} } = ts.parseJsonConfigFileContent(tsconfig.config, ts.sys, appDir).options
    for (const [key, targets] of Object.entries(paths)) {
        if (key.startsWith(SCOPE) && key !== APP_UI && !key.startsWith(`${APP_UI}/`)) {
            violations.push(`${app}: tsconfig paths map ${key} to ${targets.join(", ")}`)
        }
    }

    if (declared.has(APP_UI)) {
        const dir = installedDir(APP_UI, appDir)
        if (dir !== join(packagesDir, "app-ui"))
            violations.push(`${app}: ${APP_UI} resolves to ${dir}, expected packages/app-ui`)
    }

    for (let item = queue.shift(); item; item = queue.shift()) {
        if (item.name === APP_UI) continue
        const dir = installedDir(item.name, item.fromDir)
        // Absent means an optional peer; a missing dependency fails the install itself.
        if (!dir || seen.has(dir)) continue
        seen.add(dir)
        packageCount++
        if (dir.startsWith(packagesDir + sep)) violations.push(`${item.chain} -> ${item.name}: ${dir}`)

        const { dependencies, peerDependencies } = readManifest(dir)
        for (const name of scoped({ ...dependencies, ...peerDependencies })) {
            queue.push({ name, fromDir: dir, chain: `${item.chain} -> ${item.name}` })
        }
    }
}

if (violations.length > 0) {
    for (const violation of violations) console.error(violation)
    process.exit(1)
}
console.info(`${APPS.length} apps checked, ${packageCount} published packages resolved outside packages/`)
