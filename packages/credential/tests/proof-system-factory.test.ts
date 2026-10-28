import { Noir } from "@noir-lang/noir_js"
import { Barretenberg, UltraHonkBackend } from "@aztec/bb.js"
import { ZkCredentialProofSystem, type ZkCredentialCircuit } from "../src/zk-proof"
import type { ZkPresentationInputs } from "../src/presentation-inputs"

jest.mock("@noir-lang/noir_js", () => ({ Noir: jest.fn() }))
jest.mock("@aztec/bb.js", () => ({ Barretenberg: { new: jest.fn() }, UltraHonkBackend: jest.fn() }))

const circuit = {
    bytecode: "compiled-circuit",
    abi: {
        parameters: ["current_time", "challenge", "audience", "required_programme_hash", "required_country_code"].map(
            (name) => ({ name, visibility: "public" })
        ),
        return_type: {
            visibility: "public",
            abi_type: { kind: "tuple", fields: [{ kind: "field" }, { kind: "field" }] }
        }
    }
} as unknown as ZkCredentialCircuit

describe("proof-system initialization", () => {
    afterEach(() => {
        jest.resetAllMocks()
    })

    it("uses the selected circuit/runtime options and disposes the created runtime", async () => {
        const api = { destroy: jest.fn().mockResolvedValue(undefined) }
        const witness = new Uint8Array([1, 2])
        const execute = jest.fn().mockResolvedValue({ witness })
        const proof = { proof: new Uint8Array([3]), publicInputs: ["4"] }
        const generateProof = jest.fn().mockResolvedValue(proof)
        jest.mocked(Barretenberg.new).mockResolvedValue(api as unknown as Barretenberg)
        jest.mocked(Noir).mockImplementation(() => ({ execute }) as unknown as Noir)
        jest.mocked(UltraHonkBackend).mockImplementation(() => ({ generateProof }) as unknown as UltraHonkBackend)
        const options = { backend: { threads: 1 }, proof: { keccak: true } }
        const system = await ZkCredentialProofSystem.create(circuit, options)
        const inputs = {} as ZkPresentationInputs

        await expect(system.generateProof(inputs)).resolves.toEqual(proof)
        expect(Barretenberg.new).toHaveBeenCalledWith(options.backend)
        expect(Noir).toHaveBeenCalledWith(circuit)
        expect(UltraHonkBackend).toHaveBeenCalledWith(circuit.bytecode, api)
        expect(execute).toHaveBeenCalledWith(inputs)
        expect(generateProof).toHaveBeenCalledWith(witness, options.proof)
        await system.destroy()
        expect(api.destroy).toHaveBeenCalledTimes(1)
    })

    it("propagates runtime initialization failures without constructing a prover", async () => {
        const failure = new Error("prover unavailable")
        jest.mocked(Barretenberg.new).mockRejectedValue(failure)
        await expect(ZkCredentialProofSystem.create(circuit)).rejects.toBe(failure)
        expect(Noir).not.toHaveBeenCalled()
        expect(UltraHonkBackend).not.toHaveBeenCalled()
    })
})
