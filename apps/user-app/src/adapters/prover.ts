import AsyncStorage from "@react-native-async-storage/async-storage"
import type { CompiledCircuit } from "@noir-lang/noir_js"
import { Asset } from "expo-asset"
import {
    createNativeProofGenerator,
    type NativeProofGenerator,
    type NativeProverModule
} from "@coordination-network/noir-prover-native"
import credentialCircuit from "../generated/credential-abi.json"
import circuitAsset from "../../assets/credential.noir"
import srsAsset from "../../assets/g1-131073.dat"

export interface ProverOptions {
    /** A key from a previous launch; without one the first proof pays about a second to rebuild it. */
    verificationKey?: Uint8Array
    onVerificationKey?: (key: Uint8Array) => void
}

/** Rust reads these with `std::fs`, which has no notion of a URI scheme. */
async function localPath(module: number): Promise<string> {
    const [asset] = await Asset.loadAsync(module)
    const uri = asset.localUri ?? asset.uri
    return uri.replace(/^file:\/\//, "")
}

/**
 * Deferred rather than imported at module scope: `noir-prover-ffi` dlopens the native library as it
 * evaluates, and a failure there would crash the app at launch instead of surfacing as a failed
 * proof to the member app that requested it. A `require` inside the function still defers that
 * evaluation to the first proof — Metro runs a module body on its first require, not at bundle
 * load.
 *
 * It must not be an `import()`. Expo's dev server bundles lazily, so a dynamic import becomes a
 * separately fetched bundle segment, and React Native reloads the whole app when such a segment
 * registers while Metro's websocket is down (`HMRClient.js`, `DevSettings.reload('Bundle
 * Splitting – Metro disconnected')`). That destroyed the JS instance holding the pending proof:
 * the window went dark and no proof ever arrived. A static require is an ordinary edge in Metro's
 * graph, so the binding ships in the main bundle and nothing registers a segment at proof time.
 */
async function loadProverModule(): Promise<NativeProverModule> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const moproFfi: typeof import("@coordination-network/noir-prover-ffi") = require("@coordination-network/noir-prover-ffi")
    return moproFfi.default.noir_prover_native as NativeProverModule
}

/** On-device paths to the compiled circuit and the SRS, unpacked from the app bundle. */
export async function resolveProverAssets(): Promise<{ circuitPath: string; srsPath: string }> {
    const [circuitPath, srsPath] = await Promise.all([localPath(circuitAsset), localPath(srsAsset)])
    return { circuitPath, srsPath }
}

/**
 * The prover the wallet uses on device. Hermes has no `WebAssembly`, so the bb.js proof system the
 * SDK ships cannot run here; this is the same circuit proved natively, and the member server
 * verifies the result with the unchanged verifier.
 */
export async function createProver(options: ProverOptions = {}): Promise<NativeProofGenerator> {
    const { circuitPath, srsPath } = await resolveProverAssets()
    const cached = options.verificationKey ?? (await readCachedVerificationKey())

    return createNativeProofGenerator({
        loadModule: loadProverModule,
        abi: circuitAbi(),
        circuitHash: credentialCircuit.hash,
        circuitPath,
        srsPath,
        verificationKey: cached,
        onVerificationKey: (key) => {
            void writeCachedVerificationKey(key)
            options.onVerificationKey?.(key)
        }
    })
}

/**
 * A JSON import widens every string literal, so the ABI's discriminated unions no longer match
 * `Abi` — this narrows it back with a runtime check instead of a type-only cast.
 */
function assertCircuitAbi(value: unknown): asserts value is CompiledCircuit["abi"] {
    if (typeof value !== "object" || value === null || !("parameters" in value) || !Array.isArray(value.parameters)) {
        throw new Error("credential-abi.json has no abi.parameters — re-run scripts/sync-assets.sh")
    }
}

function circuitAbi(): CompiledCircuit["abi"] {
    const abi: unknown = credentialCircuit.abi
    assertCircuitAbi(abi)
    return abi
}

/**
 * Barretenberg rebuilds the verification key inside every proof unless handed one, which costs
 * about a second. It derives from the circuit alone and is not secret, so it is cached in plain
 * storage, keyed by the circuit hash so a recompiled circuit invalidates it rather than proving
 * against a stale key.
 */
const VERIFICATION_KEY_KEY = `user-app.verification-key.${credentialCircuit.hash}`

async function readCachedVerificationKey(): Promise<Uint8Array | undefined> {
    const raw = await AsyncStorage.getItem(VERIFICATION_KEY_KEY)
    return raw === null ? undefined : Uint8Array.from(JSON.parse(raw) as number[])
}

async function writeCachedVerificationKey(key: Uint8Array): Promise<void> {
    await AsyncStorage.setItem(VERIFICATION_KEY_KEY, JSON.stringify(Array.from(key)))
}
