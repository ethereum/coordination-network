import type { BackendOptions, ProofData, UltraHonkBackendOptions } from "@aztec/bb.js"
import type { CompiledCircuit } from "@noir-lang/noir_js"
import type { InputMap } from "@noir-lang/noir_js"
import { countryCode, programmeHash, stringToField } from "./credential-message"
import { challengeToField, ZkPresentationInputs } from "./presentation-inputs"

const PUBLIC_INPUT_NAMES = [
    "current_time",
    "challenge",
    "audience",
    "required_programme_hash",
    "required_country_code"
] as const

type PublicInputName = (typeof PUBLIC_INPUT_NAMES)[number]

export type ZkCredentialCircuit = CompiledCircuit
export type ZkPresentationProof = ProofData

export interface ExpectedZkPresentation {
    currentTime: number
    challenge: Uint8Array
    audience: string
    programme: string
    country: string
}

/**
 * `approvedIssuerRoot` and `revocationRoot` are the proof's public outputs and are
 * not checked here. Check them against the registries before accepting the presentation:
 * the issuer root against the approved-issuer set, the revocation root with the revocation
 * registry's `isValidRoot`.
 */
export type ZkPresentationVerifyResult =
    | { ok: true; approvedIssuerRoot: bigint; revocationRoot: bigint }
    | { ok: false; code: "PUBLIC_INPUT_MISMATCH"; publicInput?: PublicInputName }
    | { ok: false; code: "PROOF_INVALID" }

export interface ZkProofSystemOptions {
    backend?: BackendOptions
    proof?: UltraHonkBackendOptions
}

interface NoirExecutor {
    execute(inputs: InputMap): Promise<{ witness: Uint8Array; returnValue: unknown }>
}

interface ProofBackend {
    generateProof(witness: Uint8Array, options?: UltraHonkBackendOptions): Promise<ProofData>
    verifyProof(proof: ProofData, options?: UltraHonkBackendOptions): Promise<boolean>
}

interface DisposableBackend {
    destroy(): Promise<void>
}

const publicParameterNames = (circuit: CompiledCircuit): string[] =>
    circuit.abi.parameters.filter((parameter) => parameter.visibility === "public").map((parameter) => parameter.name)

export const assertZkCredentialCircuitAbi = (circuit: CompiledCircuit): void => {
    const actual = publicParameterNames(circuit)
    if (
        actual.length !== PUBLIC_INPUT_NAMES.length ||
        actual.some((name, index) => name !== PUBLIC_INPUT_NAMES[index])
    ) {
        throw new Error(`unexpected credential circuit public inputs: ${actual.join(", ")}`)
    }

    const returnType = circuit.abi.return_type
    if (
        returnType === null ||
        returnType.visibility !== "public" ||
        returnType.abi_type.kind !== "tuple" ||
        returnType.abi_type.fields.length !== 2 ||
        returnType.abi_type.fields.some((field) => field.kind !== "field")
    ) {
        throw new Error("credential circuit must return the proven issuer and revocation roots as public Fields")
    }
}

const expectedPublicInputs = (expected: ExpectedZkPresentation): bigint[] => {
    if (!Number.isSafeInteger(expected.currentTime) || expected.currentTime < 0) {
        throw new Error("currentTime must be a non-negative safe integer")
    }

    return [
        BigInt(expected.currentTime),
        challengeToField(expected.challenge),
        stringToField(expected.audience),
        programmeHash(expected.programme),
        BigInt(countryCode(expected.country))
    ]
}

const proofPublicValues = (proof: ZkPresentationProof): bigint[] | null => {
    if (proof.publicInputs.length !== PUBLIC_INPUT_NAMES.length + 2) return null
    try {
        return proof.publicInputs.map(BigInt)
    } catch {
        return null
    }
}

const publicInputMismatch = (
    proof: ZkPresentationProof,
    expected: ExpectedZkPresentation
): PublicInputName | undefined | null => {
    const values = proofPublicValues(proof)
    if (values === null) return null
    const actual = values.slice(0, PUBLIC_INPUT_NAMES.length)
    const wanted = expectedPublicInputs(expected)
    const mismatch = actual.findIndex((value, index) => value !== wanted[index])
    return mismatch < 0 ? undefined : PUBLIC_INPUT_NAMES[mismatch]
}

export class ZkCredentialProofSystem {
    private constructor(
        private readonly noir: NoirExecutor,
        private readonly backend: ProofBackend,
        private readonly api: DisposableBackend,
        private readonly proofOptions?: UltraHonkBackendOptions
    ) {}

    static async create(
        circuit: CompiledCircuit,
        options: ZkProofSystemOptions = {}
    ): Promise<ZkCredentialProofSystem> {
        assertZkCredentialCircuitAbi(circuit)
        const [{ Noir }, { Barretenberg, UltraHonkBackend }] = await Promise.all([
            import("@noir-lang/noir_js"),
            import("@aztec/bb.js")
        ])
        const api = await Barretenberg.new(options.backend)
        return new ZkCredentialProofSystem(
            new Noir(circuit),
            new UltraHonkBackend(circuit.bytecode, api),
            api,
            options.proof
        )
    }

    async generateProof(inputs: ZkPresentationInputs): Promise<ZkPresentationProof> {
        try {
            const { witness } = await this.noir.execute(inputs as unknown as InputMap)
            const proof = await this.backend.generateProof(witness, this.proofOptions)
            return { proof: proof.proof, publicInputs: [...proof.publicInputs] }
        } catch {
            // The circuit's assertion text distinguishes "not yet valid" from "expired".
            // Both outcomes must be indistinguishable to the verifier that chose currentTime.
            throw new Error("presentation proof failed")
        }
    }

    async verifyProof(
        proof: ZkPresentationProof,
        expected: ExpectedZkPresentation
    ): Promise<ZkPresentationVerifyResult> {
        const mismatch = publicInputMismatch(proof, expected)
        if (mismatch === null) return { ok: false, code: "PUBLIC_INPUT_MISMATCH" }
        if (mismatch !== undefined) return { ok: false, code: "PUBLIC_INPUT_MISMATCH", publicInput: mismatch }
        if (!(proof.proof instanceof Uint8Array) || proof.proof.length === 0 || proof.proof.length % 32 !== 0) {
            return { ok: false, code: "PROOF_INVALID" }
        }

        try {
            if (!(await this.backend.verifyProof(proof, this.proofOptions))) {
                return { ok: false, code: "PROOF_INVALID" }
            }
            const publicValues = proofPublicValues(proof)!
            return {
                ok: true,
                approvedIssuerRoot: publicValues[PUBLIC_INPUT_NAMES.length],
                revocationRoot: publicValues[PUBLIC_INPUT_NAMES.length + 1]
            }
        } catch {
            return { ok: false, code: "PROOF_INVALID" }
        }
    }

    async destroy(): Promise<void> {
        await this.api.destroy()
    }
}

export async function generateZkPresentationProof(
    circuit: CompiledCircuit,
    inputs: ZkPresentationInputs,
    options: ZkProofSystemOptions = {}
): Promise<ZkPresentationProof> {
    const proofSystem = await ZkCredentialProofSystem.create(circuit, options)
    try {
        return await proofSystem.generateProof(inputs)
    } finally {
        await proofSystem.destroy()
    }
}

/**
 * Verifies a presentation proof against the expected public inputs and returns the roots
 * from the proof. Check those roots against the registries; see {@link ZkPresentationVerifyResult}.
 */
export async function verifyZkPresentationProof(
    circuit: CompiledCircuit,
    proof: ZkPresentationProof,
    expected: ExpectedZkPresentation,
    options: ZkProofSystemOptions = {}
): Promise<ZkPresentationVerifyResult> {
    const proofSystem = await ZkCredentialProofSystem.create(circuit, options)
    try {
        return await proofSystem.verifyProof(proof, expected)
    } finally {
        await proofSystem.destroy()
    }
}
