import {
    zkPresentationInputsToWitness,
    type ZkPresentationInputs,
    type ZkPresentationProof
} from "@coordination-network/credential"
import type { CompiledCircuit } from "@noir-lang/noir_js"
import type { ProofGenerator } from "@coordination-network/wallet"

/**
 * The generated UniFFI surface, injected rather than imported, so this package pulls in no React
 * Native dependency and stays runnable under jest. An app passes a loader that resolves to the
 * module from `MoproReactNativeBindings`; a test passes one that resolves to a fake.
 *
 * `proveCredential` returns a promise because it is an `async fn` on the Rust side, which proves on
 * a thread of its own; the JS thread stays free while it runs. Setup is synchronous, as UniFFI
 * returns a promise only for an `async fn` — both calls are short and happen before the first proof.
 */
export interface NativeProverModule {
    initSrs(circuitPath: string, srsPath: string, expectedHash: string): number
    credentialVerificationKey(circuitPath: string, lowMemoryMode: boolean): ArrayBuffer
    proveCredential(
        circuitPath: string,
        witness: string[],
        vk: ArrayBuffer,
        lowMemoryMode: boolean
    ): Promise<{ proof: string; publicInputs: string[] }>
}

export interface NativeProofGeneratorOptions {
    /**
     * Called lazily, on the first `generateProof`, and the resulting promise cached for the
     * generator's lifetime — including a rejection, so a module that fails to load once will
     * fail to load again rather than retry.
     */
    loadModule: () => Promise<NativeProverModule>
    /** The compiled circuit's ABI. The prover itself reads the artifact from `circuitPath`. */
    abi: CompiledCircuit["abi"]
    /**
     * The hash of the artifact `abi` came from. The prover refuses to set up against a `circuitPath`
     * whose hash differs, rather than proving a witness ordered by one circuit against another.
     */
    circuitHash: string
    /** On-device path to that same artifact. */
    circuitPath: string
    /** On-device path to the bundled SRS G1 prefix. */
    srsPath: string
    /**
     * A key from a previous launch. Without one, barretenberg recomputes it inside every proof,
     * which costs roughly a second each time.
     */
    verificationKey?: Uint8Array
    /** Receives a freshly computed key so the app can persist it. */
    onVerificationKey?: (key: Uint8Array) => void
    lowMemoryMode?: boolean
    now?: () => number
}

export interface NativeProofGenerator extends ProofGenerator {
    /** Wall-clock milliseconds the last proof took, for the screen that reports it. */
    readonly lastProvingMs: number | null
}

function hexToBytes(hex: string): Uint8Array {
    const body = hex.startsWith("0x") ? hex.slice(2) : hex
    const bytes = new Uint8Array(body.length / 2)
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(body.slice(index * 2, index * 2 + 2), 16)
    }
    return bytes
}

/** UniFFI takes an ArrayBuffer; a Uint8Array may be a view into a larger or shared buffer. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    const copy = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(copy).set(bytes)
    return copy
}

/**
 * A {@link ProofGenerator} backed by the native prover, for React Native where Hermes has no
 * `WebAssembly` and `ZkCredentialProofSystem` therefore cannot run.
 *
 * SRS setup is process-global and first-call-wins in barretenberg, so it happens once here rather
 * than per proof.
 */
export function createNativeProofGenerator(options: NativeProofGeneratorOptions): NativeProofGenerator {
    const { loadModule, abi, circuitHash, circuitPath, srsPath, onVerificationKey } = options
    const lowMemoryMode = options.lowMemoryMode ?? false
    const now = options.now ?? Date.now

    let verificationKey = options.verificationKey
    let modulePromise: Promise<NativeProverModule> | undefined
    let srsReady = false
    let lastProvingMs: number | null = null

    return {
        get lastProvingMs() {
            return lastProvingMs
        },

        async generateProof(inputs: ZkPresentationInputs): Promise<ZkPresentationProof> {
            const module = await (modulePromise ??= loadModule())

            if (!srsReady) {
                module.initSrs(circuitPath, srsPath, circuitHash)
                srsReady = true
            }

            if (verificationKey === undefined) {
                verificationKey = new Uint8Array(module.credentialVerificationKey(circuitPath, lowMemoryMode))
                onVerificationKey?.(verificationKey)
            }

            const witness = zkPresentationInputsToWitness(abi, inputs)

            const started = now()
            const proof = await module.proveCredential(
                circuitPath,
                witness,
                toArrayBuffer(verificationKey),
                lowMemoryMode
            )
            lastProvingMs = now() - started

            return { proof: hexToBytes(proof.proof), publicInputs: proof.publicInputs }
        }
    }
}
