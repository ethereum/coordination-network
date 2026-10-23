const path = require("path")
const { getDefaultConfig } = require("expo/metro-config")

const config = getDefaultConfig(__dirname)

// A wedged watchman daemon blocks Metro's file map forever; the node
// crawler/watcher is fast enough for a workspace this small.
config.resolver.useWatchman = false

// The SRS and the compiled circuit ship as binary assets: the native prover reads them as files,
// and inlining the circuit's 1.9 MB of bytecode into the JS bundle would help nobody.
config.resolver.assetExts.push("dat", "noir")

// `@coordination-network/credential` reaches the WASM proving stack through one dynamic import,
// which Metro still has to resolve even though the native prover means it is never taken. Neither
// package can run here anyway: bb.js uses `import.meta`, which Hermes cannot parse, and noir_js
// pulls a Node build that wants `fs`.
const WASM_PROVING_PACKAGES = ["@aztec/bb.js", "@noir-lang/noir_js"]
const provingStub = path.resolve(__dirname, "src/adapters/wasm-proving-stub.ts")
const defaultResolveRequest = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
    if (WASM_PROVING_PACKAGES.some((pkg) => moduleName === pkg || moduleName.startsWith(`${pkg}/`))) {
        return { type: "sourceFile", filePath: provingStub }
    }
    return (defaultResolveRequest ?? context.resolveRequest)(context, moduleName, platform)
}

module.exports = config
