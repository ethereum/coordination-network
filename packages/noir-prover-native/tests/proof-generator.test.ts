import { describe, it, expect, jest } from "@jest/globals"
import type { CompiledCircuit } from "@noir-lang/noir_js"
import type { ZkPresentationInputs } from "@coordination-network/credential"
import { createNativeProofGenerator, type NativeProverModule } from "../src"

/** A two-parameter stand-in: the depth-first walk itself is covered in `packages/credential`. */
const abi = {
    parameters: [
        { name: "current_time", type: { kind: "integer", sign: "unsigned", width: 64 }, visibility: "public" },
        { name: "flags", type: { kind: "array", length: 2, type: { kind: "boolean" } }, visibility: "private" }
    ],
    return_type: null,
    error_types: {}
} as unknown as CompiledCircuit["abi"]

const inputs = { current_time: "1760000000", flags: [true, false] } as unknown as ZkPresentationInputs

interface Calls {
    initSrs: number
    circuitHashes: string[]
    verificationKey: number
    witnesses: string[][]
    vks: Uint8Array[]
}

function fakeModule(): { module: NativeProverModule; calls: Calls } {
    const calls: Calls = { initSrs: 0, circuitHashes: [], verificationKey: 0, witnesses: [], vks: [] }
    const module: NativeProverModule = {
        initSrs(_circuitPath, _srsPath, expectedHash) {
            calls.initSrs += 1
            calls.circuitHashes.push(expectedHash)
            return 131073
        },
        credentialVerificationKey() {
            calls.verificationKey += 1
            return new Uint8Array([7, 7, 7]).buffer as ArrayBuffer
        },
        async proveCredential(_circuitPath, witness, vk) {
            calls.witnesses.push(witness)
            calls.vks.push(new Uint8Array(vk))
            return { proof: "0xdeadbeef", publicInputs: ["0x01", "0x02"] }
        }
    }
    return { module, calls }
}

describe("createNativeProofGenerator", () => {
    it("flattens the inputs against the circuit ABI and returns the proof as bytes", async () => {
        const { module, calls } = fakeModule()
        const generator = createNativeProofGenerator({
            loadModule: async () => module,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat"
        })

        const proof = await generator.generateProof(inputs)

        expect(calls.witnesses[0]).toEqual(["1760000000", "1", "0"])
        expect(Array.from(proof.proof)).toEqual([0xde, 0xad, 0xbe, 0xef])
        expect(proof.publicInputs).toEqual(["0x01", "0x02"])
    })

    it("sets the SRS up once across proofs, because barretenberg's is process-global", async () => {
        const { module, calls } = fakeModule()
        const generator = createNativeProofGenerator({
            loadModule: async () => module,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat"
        })

        await generator.generateProof(inputs)
        await generator.generateProof(inputs)

        expect(calls.initSrs).toBe(1)
        // The prover refuses an artifact whose hash differs from the ABI's, so setup has to carry it.
        expect(calls.circuitHashes).toEqual(["1468"])
    })

    it("computes the verification key once and hands it back for the app to persist", async () => {
        const { module, calls } = fakeModule()
        const persisted: Uint8Array[] = []
        const generator = createNativeProofGenerator({
            loadModule: async () => module,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat",
            onVerificationKey: (key) => persisted.push(key)
        })

        await generator.generateProof(inputs)
        await generator.generateProof(inputs)

        expect(calls.verificationKey).toBe(1)
        expect(persisted).toHaveLength(1)
        expect(Array.from(persisted[0])).toEqual([7, 7, 7])
        expect(Array.from(calls.vks[1])).toEqual([7, 7, 7])
    })

    it("uses a supplied verification key rather than recomputing one", async () => {
        const { module, calls } = fakeModule()
        const generator = createNativeProofGenerator({
            loadModule: async () => module,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat",
            verificationKey: new Uint8Array([1, 2])
        })

        await generator.generateProof(inputs)

        expect(calls.verificationKey).toBe(0)
        expect(Array.from(calls.vks[0])).toEqual([1, 2])
    })

    it("reports how long the last proof took, measured across the await", async () => {
        const { module } = fakeModule()
        let clock = 1_000
        // The clock only moves once the proof's promise is about to settle, so a measurement taken
        // when the call was merely started would read zero.
        const slowModule: NativeProverModule = {
            ...module,
            async proveCredential(...args) {
                const proof = await module.proveCredential(...args)
                clock = 1_711
                return proof
            }
        }
        const generator = createNativeProofGenerator({
            loadModule: async () => slowModule,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat",
            now: () => clock
        })

        expect(generator.lastProvingMs).toBeNull()
        await generator.generateProof(inputs)
        expect(generator.lastProvingMs).toBe(711)
    })

    it("does not load the module before the first proof, and loads it once", async () => {
        const { module } = fakeModule()
        const loadModule = jest.fn(async () => module)
        const generator = createNativeProofGenerator({
            loadModule,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat"
        })

        expect(loadModule).not.toHaveBeenCalled()

        await generator.generateProof(inputs)
        await generator.generateProof(inputs)

        expect(loadModule).toHaveBeenCalledTimes(1)
    })

    it("a module that fails to load rejects the proof with that error", async () => {
        const loadError = new Error("dlopen failed")
        const loadModule = jest.fn<() => Promise<NativeProverModule>>(async () => {
            throw loadError
        })
        const generator = createNativeProofGenerator({
            loadModule,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat"
        })

        await expect(generator.generateProof(inputs)).rejects.toThrow(loadError)
        await expect(generator.generateProof(inputs)).rejects.toThrow(loadError)

        expect(loadModule).toHaveBeenCalledTimes(1)
    })

    it("does not mark the SRS ready when initSrs throws, so the next proof retries it", async () => {
        const { module, calls } = fakeModule()
        let throwHashMismatch = true
        const generator = createNativeProofGenerator({
            loadModule: async () => ({
                ...module,
                initSrs(...args: Parameters<NativeProverModule["initSrs"]>) {
                    if (throwHashMismatch) throw new Error("SRS hash mismatch")
                    return module.initSrs(...args)
                }
            }),
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat"
        })

        await expect(generator.generateProof(inputs)).rejects.toThrow("SRS hash mismatch")

        throwHashMismatch = false
        const proof = await generator.generateProof(inputs)

        expect(calls.initSrs).toBe(1)
        expect(Array.from(proof.proof)).toEqual([0xde, 0xad, 0xbe, 0xef])
    })

    it("rejects the proof and leaves lastProvingMs at its previous value when proveCredential rejects", async () => {
        const { module } = fakeModule()
        let clock = 1_000
        let callCount = 0
        const flakyModule: NativeProverModule = {
            ...module,
            async proveCredential(...args) {
                callCount += 1
                if (callCount === 1) {
                    const proof = await module.proveCredential(...args)
                    clock = 1_500
                    return proof
                }
                clock = 2_000
                throw new Error("proving failed")
            }
        }
        const generator = createNativeProofGenerator({
            loadModule: async () => flakyModule,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat",
            now: () => clock
        })

        await generator.generateProof(inputs)
        expect(generator.lastProvingMs).toBe(500)

        await expect(generator.generateProof(inputs)).rejects.toThrow("proving failed")
        expect(generator.lastProvingMs).toBe(500)
    })

    it("two proofs started together before the module has loaded share one load", async () => {
        const { module } = fakeModule()
        let resolveLoad: (module: NativeProverModule) => void = () => {
            throw new Error("resolveLoad called before assignment")
        }
        const loadModule = jest.fn(
            () =>
                new Promise<NativeProverModule>((resolve) => {
                    resolveLoad = resolve
                })
        )
        const generator = createNativeProofGenerator({
            loadModule,
            abi,
            circuitHash: "1468",
            circuitPath: "c.json",
            srsPath: "g1.dat"
        })

        const first = generator.generateProof(inputs)
        const second = generator.generateProof(inputs)
        resolveLoad(module)
        const [proofA, proofB] = await Promise.all([first, second])

        expect(loadModule).toHaveBeenCalledTimes(1)
        expect(Array.from(proofA.proof)).toEqual([0xde, 0xad, 0xbe, 0xef])
        expect(Array.from(proofB.proof)).toEqual([0xde, 0xad, 0xbe, 0xef])
    })
})
