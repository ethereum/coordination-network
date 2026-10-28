import fs from "fs"
import type { Config } from "jest"

// app-ui is React Native components, which the root ts-jest preset can't transform or run. The
// Noir circuits hold no TypeScript, and zk-artifacts resolves its own files through
// `import.meta.url`, which ts-jest's CommonJS output cannot carry; it runs under `tsx --test`.
const exclude: string[] = ["app-ui", "circuits", "zk-artifacts"]

// ts-jest only transpiles: type-checking every test file separately was most of the run time.
// `yarn typecheck` checks each package's src and tests in one pass instead.
const transpileOnly = { isolatedModules: true }

// @scopelift/stealth-address-sdk and its @noble/secp256k1 v2 dependency ship
// as malformed ESM modules that Node cannot load
// natively, so the stealth crosscheck test routes them through ts-jest.
function scopeliftEsmWorkaround() {
    return {
        transformIgnorePatterns: ["node_modules/(?!(@scopelift|@noble/secp256k1)/)"],
        transform: {
            "^.+\\.[tj]s$": ["ts-jest", { tsconfig: { ...transpileOnly, allowJs: true } }] as const
        }
    }
}

function isHybridModulePackage(name: string) {
    try {
        const tsconfig = JSON.parse(fs.readFileSync(`./packages/${name}/tsconfig.json`, "utf8"))
        return /^node(next|16|18)$/i.test(tsconfig.compilerOptions?.module ?? "")
    } catch {
        return false
    }
}

const commonjsEmit = {
    transform: {
        "^.+\\.tsx?$": [
            "ts-jest",
            { tsconfig: { ...transpileOnly, module: "esnext", moduleResolution: "bundler" } }
        ] as const
    }
}

const projects: Config["projects"] = fs
    .readdirSync("./packages", { withFileTypes: true })
    .filter((directory) => directory.isDirectory())
    .filter((directory) => !exclude.includes(directory.name))
    .map(({ name }) => ({
        preset: "ts-jest",
        transform: { "^.+\\.tsx?$": ["ts-jest", { tsconfig: transpileOnly }] as const },
        rootDir: `packages/${name}`,
        displayName: name,
        setupFiles: ["dotenv/config"],
        moduleNameMapper: {
            "@coordination-network/(.*)/(.*)": "<rootDir>/../$1/src/$2",
            "@coordination-network/(.*)": "<rootDir>/../$1/src"
        },
        ...(name === "identity" && scopeliftEsmWorkaround()),
        ...(isHybridModulePackage(name) && commonjsEmit),
        ...(name === "network-member-proof" && { setupFilesAfterEnv: ["<rootDir>/tests/jest.setup.ts"] }),
        // The anvil harness is test scaffolding, not a coverage target.
        ...(["user-client", "network-member-client"].includes(name) && {
            coveragePathIgnorePatterns: ["/node_modules/", "/tests/integration/"]
        }),
        // native.ts calls into the real Android module; nothing to exercise under jest.
        ...(name === "expo-identity-keystore" && { coveragePathIgnorePatterns: ["/node_modules/", "/src/native.ts"] })
    }))

// TODO: resolve this later to simplify config
// the indexer runs under tsx rather than a build step, so it imports with explicit .ts
// extensions. Left alone, ts-jest rewrites those to .js, which resolves to nothing
const indexer: Config = {
    rootDir: "apps/indexer",
    displayName: "indexer",
    transform: {
        "^.+\\.ts$": [
            "ts-jest",
            {
                tsconfig: {
                    allowImportingTsExtensions: true,
                    rewriteRelativeImportExtensions: false
                }
            }
        ]
    },
    // the environment must be set before any worker loads config.ts
    globalSetup: "<rootDir>/tests/loadTestEnv.ts"
}

const config: Config = {
    projects: [...projects, indexer],
    testTimeout: 20_000,
    // Two proving-heavy files in one worker exceed the ~2GB CI gives each process.
    workerIdleMemoryLimit: "512MB",
    verbose: true,
    // ts-jest compiles `index.ts` files to getter functions. The getters count as untested code.
    collectCoverageFrom: ["packages/*/src/**/*.ts", "!**/index.ts", "!packages/zk-artifacts/src/**"],
    coverageDirectory: "./coverage",
    // zk-artifacts runs under `tsx --test`, so its package.json repeats these.
    coverageThreshold: {
        global: {
            branches: 95,
            functions: 98,
            lines: 98,
            statements: 98
        }
    }
}

export default config
