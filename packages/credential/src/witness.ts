import type { CompiledCircuit } from "@noir-lang/noir_js"
import { ZkPresentationInputs } from "./presentation-inputs"

type CircuitAbi = CompiledCircuit["abi"]
type AbiType = CircuitAbi["parameters"][number]["type"]

const DECIMAL_RE = /^(0|[1-9][0-9]*)$/

function scalarWitness(value: unknown, path: string): string {
    if (typeof value !== "string" || !DECIMAL_RE.test(value)) {
        throw new Error(`zkPresentationInputsToWitness: ${path} must be a canonical decimal string`)
    }
    return value
}

function booleanWitness(value: unknown, path: string): string {
    if (typeof value !== "boolean") {
        throw new Error(`zkPresentationInputsToWitness: ${path} must be a boolean`)
    }
    return value ? "1" : "0"
}

/** Depth-first ABI walk (spec: field/integer -> decimal string, boolean -> "1"/"0", array/struct recurse). */
function emit(type: AbiType, value: unknown, path: string, witness: string[]): void {
    switch (type.kind) {
        case "field":
        case "integer":
            witness.push(scalarWitness(value, path))
            return
        case "boolean":
            witness.push(booleanWitness(value, path))
            return
        case "array":
            if (!Array.isArray(value) || value.length !== type.length) {
                throw new Error(`zkPresentationInputsToWitness: ${path} must be an array of length ${type.length}`)
            }
            value.forEach((element, index) => emit(type.type, element, `${path}[${index}]`, witness))
            return
        case "struct": {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
                throw new Error(`zkPresentationInputsToWitness: ${path} must be an object`)
            }
            const fields = value as Record<string, unknown>
            type.fields.forEach((field) => emit(field.type, fields[field.name], `${path}.${field.name}`, witness))
            return
        }
        default:
            throw new Error(`zkPresentationInputsToWitness: ${path} has unsupported ABI type "${type.kind}"`)
    }
}

/**
 * Flattens {@link ZkPresentationInputs} into the ordered `string[]` witness a
 * native Noir prover consumes, walking the compiled circuit's ABI (public and
 * private parameters, in declaration order) rather than the JS object's own
 * key order — a struct field reorder in the circuit changes the ABI and so
 * changes this output, instead of silently desyncing from it.
 */
export function zkPresentationInputsToWitness(abi: CircuitAbi, inputs: ZkPresentationInputs): string[] {
    const record: Record<string, unknown> = { ...inputs }
    const witness: string[] = []
    for (const parameter of abi.parameters) {
        if (!(parameter.name in record)) {
            throw new Error(`zkPresentationInputsToWitness: unknown ABI parameter "${parameter.name}"`)
        }
        emit(parameter.type, record[parameter.name], parameter.name, witness)
    }
    return witness
}
