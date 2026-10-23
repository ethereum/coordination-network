// Type-checks each package's src and tests in one pass. The test runners only transpile.
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import ts from "typescript"

// ts-jest's default ignored diagnostics: 6059 (rootDir), 18002 and 18003 (no inputs or outputs).
const ignoredCodes = new Set([6059, 18002, 18003])

const host: ts.FormatDiagnosticsHost = {
    getCanonicalFileName: (fileName) => fileName,
    getCurrentDirectory: ts.sys.getCurrentDirectory,
    getNewLine: () => ts.sys.newLine
}

// Every package with TypeScript; circuits and contracts have no tsconfig.json.
const packages = readdirSync("packages").filter((name) => existsSync(join("packages", name, "tsconfig.json")))

let failed = false
for (const name of packages) {
    const config = ts.getParsedCommandLineOfConfigFile(
        join("packages", name, "tsconfig.json"),
        {},
        {
            ...ts.sys,
            onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
                throw new Error(ts.formatDiagnostic(diagnostic, host))
            }
        }
    )
    if (!config) throw new Error(`packages/${name}: cannot read tsconfig.json`)

    const tests = join("packages", name, "tests")
    const testFiles = existsSync(tests)
        ? ts.sys.readDirectory(tests, [".ts", ".tsx"], ["**/node_modules"], ["**/*"])
        : []

    const options: ts.CompilerOptions = { ...config.options, noEmit: true }
    // jest.config.ts compiles the NodeNext packages as ESNext with bundler resolution.
    if (options.module === ts.ModuleKind.NodeNext || options.module === ts.ModuleKind.Node16) {
        options.module = ts.ModuleKind.ESNext
        options.moduleResolution = ts.ModuleResolutionKind.Bundler
    }

    const program = ts.createProgram([...new Set([...config.fileNames, ...testFiles])], options)
    const diagnostics = [...config.errors, ...ts.getPreEmitDiagnostics(program)].filter(
        ({ code }) => !ignoredCodes.has(code)
    )

    if (diagnostics.length > 0) {
        failed = true
        console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host))
    }
    console.info(`packages/${name}: ${diagnostics.length === 0 ? "ok" : `${diagnostics.length} errors`}`)
}

if (failed) process.exit(1)
