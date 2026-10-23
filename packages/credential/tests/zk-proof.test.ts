import type { InputMap } from "@noir-lang/noir_js"
import {
    challengeToField,
    ExpectedZkPresentation,
    generateZkPresentationProof,
    verifyZkPresentationProof,
    ZkCredentialCircuit,
    ZkCredentialProofSystem,
    ZkPresentationInputs,
    ZkPresentationProof
} from "@coordination-network/credential"
import { countryCode, programmeHash, stringToField } from "../src/credential-message"
import { assertZkCredentialCircuitAbi } from "../src/zk-proof"

const PUBLIC_INPUT_NAMES = [
    "current_time",
    "challenge",
    "audience",
    "required_programme_hash",
    "required_country_code"
] as const
const PROVEN_APPROVED_ISSUER_ROOT = 11n
const PROVEN_REVOCATION_ROOT = 12n

const expected: ExpectedZkPresentation = {
    currentTime: 1_760_000_000,
    challenge: Uint8Array.from({ length: 31 }, (_, index) => index + 1),
    audience: "urn:cn:network:test-verifier",
    programme: "demo-programme",
    country: "ZZZ"
}

const expectedPublicInputs = (): string[] =>
    [
        BigInt(expected.currentTime),
        challengeToField(expected.challenge),
        stringToField(expected.audience),
        programmeHash(expected.programme),
        BigInt(countryCode(expected.country)),
        PROVEN_APPROVED_ISSUER_ROOT,
        PROVEN_REVOCATION_ROOT
    ].map(String)

const proof = (overrides: Partial<ZkPresentationProof> = {}): ZkPresentationProof => ({
    proof: new Uint8Array(32).fill(1),
    publicInputs: expectedPublicInputs(),
    ...overrides
})

const inputs = {} as ZkPresentationInputs

type NoirExecutor = {
    execute(inputs: InputMap): Promise<{ witness: Uint8Array; returnValue: unknown }>
}

type ProofBackend = {
    generateProof(witness: Uint8Array, options?: unknown): Promise<ZkPresentationProof>
    verifyProof(value: ZkPresentationProof, options?: unknown): Promise<boolean>
}

type DisposableBackend = {
    destroy(): Promise<void>
}

type ProofSystemConstructor = new (
    noir: NoirExecutor,
    backend: ProofBackend,
    api: DisposableBackend,
    proofOptions?: unknown
) => ZkCredentialProofSystem

const createSystem = (verification = true) => {
    const generated = proof()
    const witness = new Uint8Array([1, 2, 3])
    const noir: NoirExecutor = {
        execute: jest.fn().mockResolvedValue({ witness, returnValue: undefined })
    }
    const backend: ProofBackend = {
        generateProof: jest.fn().mockResolvedValue(generated),
        verifyProof: jest.fn().mockResolvedValue(verification)
    }
    const api: DisposableBackend = {
        destroy: jest.fn().mockResolvedValue(undefined)
    }
    const proofOptions = { keccak: true }
    const Constructor = ZkCredentialProofSystem as unknown as ProofSystemConstructor
    const system = new Constructor(noir, backend, api, proofOptions)

    return { system, noir, backend, api, proofOptions, witness, generated }
}

const circuit = (
    names: readonly string[] = PUBLIC_INPUT_NAMES,
    returnType: unknown = {
        abi_type: { kind: "tuple", fields: [{ kind: "field" }, { kind: "field" }] },
        visibility: "public"
    }
): ZkCredentialCircuit =>
    ({
        abi: {
            parameters: names.map((name) => ({ name, visibility: "public" })),
            return_type: returnType
        }
    }) as unknown as ZkCredentialCircuit

afterEach(() => {
    jest.restoreAllMocks()
})

describe("ZkCredentialProofSystem", () => {
    it("generates a proof and forwards the configured proof options", async () => {
        const { system, noir, backend, proofOptions, witness, generated } = createSystem()

        const result = await system.generateProof(inputs)

        expect(noir.execute).toHaveBeenCalledWith(inputs)
        expect(backend.generateProof).toHaveBeenCalledWith(witness, proofOptions)
        expect(result).toEqual(generated)
        expect(result.publicInputs).not.toBe(generated.publicInputs)
    })

    it("does not reveal which validity assertion failed during proof generation", async () => {
        const { system, noir, backend } = createSystem()
        for (const assertion of ["credential is not yet valid", "credential has expired"]) {
            jest.mocked(noir.execute).mockRejectedValueOnce(new Error(assertion))
            await expect(system.generateProof(inputs)).rejects.toThrow("presentation proof failed")
        }
        expect(backend.generateProof).not.toHaveBeenCalled()
    })

    it("verifies a proof whose public inputs match the request", async () => {
        const { system, backend, proofOptions } = createSystem()
        const presentationProof = proof()

        await expect(system.verifyProof(presentationProof, expected)).resolves.toEqual({
            ok: true,
            approvedIssuerRoot: PROVEN_APPROVED_ISSUER_ROOT,
            revocationRoot: PROVEN_REVOCATION_ROOT
        })
        expect(backend.verifyProof).toHaveBeenCalledWith(presentationProof, proofOptions)
    })

    it("returns the roots proven by the circuit instead of comparing them with verifier state", async () => {
        const { system } = createSystem()
        const publicInputs = expectedPublicInputs()
        publicInputs[PUBLIC_INPUT_NAMES.length] = "99"
        publicInputs[PUBLIC_INPUT_NAMES.length + 1] = "100"

        await expect(system.verifyProof(proof({ publicInputs }), expected)).resolves.toEqual({
            ok: true,
            approvedIssuerRoot: 99n,
            revocationRoot: 100n
        })
    })

    it.each(PUBLIC_INPUT_NAMES.map((name, index) => [name, index] as const))(
        "rejects a mismatched %s before cryptographic verification",
        async (name, index) => {
            const { system, backend } = createSystem()
            const publicInputs = expectedPublicInputs()
            publicInputs[index] = String(BigInt(publicInputs[index]) + 1n)

            await expect(system.verifyProof(proof({ publicInputs }), expected)).resolves.toEqual({
                ok: false,
                code: "PUBLIC_INPUT_MISMATCH",
                publicInput: name
            })
            expect(backend.verifyProof).not.toHaveBeenCalled()
        }
    )

    it.each([
        ["missing", expectedPublicInputs().slice(1)],
        ["non-numeric", expectedPublicInputs().map((value, index) => (index === 0 ? "invalid" : value))]
    ])("rejects %s public inputs", async (_case, publicInputs) => {
        const { system, backend } = createSystem()

        await expect(system.verifyProof(proof({ publicInputs }), expected)).resolves.toEqual({
            ok: false,
            code: "PUBLIC_INPUT_MISMATCH"
        })
        expect(backend.verifyProof).not.toHaveBeenCalled()
    })

    it.each([
        ["wrong type", [] as unknown as Uint8Array],
        ["empty", new Uint8Array()],
        ["unaligned", new Uint8Array(31)]
    ])("rejects a %s proof buffer", async (_case, proofBytes) => {
        const { system, backend } = createSystem()

        await expect(system.verifyProof(proof({ proof: proofBytes }), expected)).resolves.toEqual({
            ok: false,
            code: "PROOF_INVALID"
        })
        expect(backend.verifyProof).not.toHaveBeenCalled()
    })

    it("rejects a cryptographically invalid proof", async () => {
        const { system } = createSystem(false)

        await expect(system.verifyProof(proof(), expected)).resolves.toEqual({
            ok: false,
            code: "PROOF_INVALID"
        })
    })

    it("converts a backend verification error into a safe failure", async () => {
        const { system, backend } = createSystem()
        jest.mocked(backend.verifyProof).mockRejectedValue(new Error("malformed proof"))

        await expect(system.verifyProof(proof(), expected)).resolves.toEqual({
            ok: false,
            code: "PROOF_INVALID"
        })
    })

    it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid current time %s", async (currentTime) => {
        const { system, backend } = createSystem()

        await expect(system.verifyProof(proof(), { ...expected, currentTime })).rejects.toThrow(
            "currentTime must be a non-negative safe integer"
        )
        expect(backend.verifyProof).not.toHaveBeenCalled()
    })

    it("destroys the Barretenberg API", async () => {
        const { system, api } = createSystem()

        await system.destroy()

        expect(api.destroy).toHaveBeenCalledTimes(1)
    })

    it("rejects a circuit with missing or reordered public inputs before loading the proving runtime", async () => {
        await expect(ZkCredentialProofSystem.create(circuit(PUBLIC_INPUT_NAMES.slice(1)))).rejects.toThrow(
            /unexpected credential circuit public inputs/
        )
        await expect(ZkCredentialProofSystem.create(circuit([...PUBLIC_INPUT_NAMES].reverse()))).rejects.toThrow(
            /unexpected credential circuit public inputs/
        )
    })

    it("accepts the expected public circuit ABI", () => {
        expect(() => assertZkCredentialCircuitAbi(circuit())).not.toThrow()
    })

    it.each([
        ["missing", null],
        [
            "private",
            { abi_type: { kind: "tuple", fields: [{ kind: "field" }, { kind: "field" }] }, visibility: "private" }
        ],
        ["wrong type", { abi_type: { kind: "field" }, visibility: "public" }],
        ["wrong arity", { abi_type: { kind: "tuple", fields: [{ kind: "field" }] }, visibility: "public" }],
        [
            "wrong field type",
            { abi_type: { kind: "tuple", fields: [{ kind: "field" }, { kind: "boolean" }] }, visibility: "public" }
        ]
    ])("rejects a %s root return", (_case, returnType) => {
        expect(() => assertZkCredentialCircuitAbi(circuit(PUBLIC_INPUT_NAMES, returnType))).toThrow(
            /must return the proven issuer and revocation roots as public Fields/
        )
    })
})

describe("one-shot proof helpers", () => {
    it("generates and destroys the proof system", async () => {
        const { system, generated, api } = createSystem()
        jest.spyOn(ZkCredentialProofSystem, "create").mockResolvedValue(system)

        await expect(generateZkPresentationProof(circuit(), inputs)).resolves.toEqual(generated)
        expect(api.destroy).toHaveBeenCalledTimes(1)
    })

    it("destroys the proof system when generation fails", async () => {
        const { system, noir, api } = createSystem()
        jest.mocked(noir.execute).mockRejectedValue(new Error("witness failed"))
        jest.spyOn(ZkCredentialProofSystem, "create").mockResolvedValue(system)

        await expect(generateZkPresentationProof(circuit(), inputs)).rejects.toThrow("presentation proof failed")
        expect(api.destroy).toHaveBeenCalledTimes(1)
    })

    it("verifies and destroys the proof system", async () => {
        const { system, api } = createSystem()
        jest.spyOn(ZkCredentialProofSystem, "create").mockResolvedValue(system)

        await expect(verifyZkPresentationProof(circuit(), proof(), expected)).resolves.toEqual({
            ok: true,
            approvedIssuerRoot: PROVEN_APPROVED_ISSUER_ROOT,
            revocationRoot: PROVEN_REVOCATION_ROOT
        })
        expect(api.destroy).toHaveBeenCalledTimes(1)
    })

    it("destroys the proof system when verification fails", async () => {
        const { system, backend, api } = createSystem()
        jest.mocked(backend.verifyProof).mockRejectedValue(new Error("backend failed"))
        jest.spyOn(ZkCredentialProofSystem, "create").mockResolvedValue(system)

        await expect(verifyZkPresentationProof(circuit(), proof(), expected)).resolves.toEqual({
            ok: false,
            code: "PROOF_INVALID"
        })
        expect(api.destroy).toHaveBeenCalledTimes(1)
    })
})
