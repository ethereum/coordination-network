import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { InputMap } from "@noir-lang/noir_js"
import { Noir } from "@noir-lang/noir_js"
// Neither is a declared dependency of this package: both are pinned
// transitively by the exact-pinned @noir-lang/noir_js version above, and used
// here only to drive the circuit from a flat witness vector the way a native
// prover would (mirroring what Noir.execute does internally with a structured
// InputMap: noirc_abi.abiEncode -> acvm_js.executeProgram -> abiDecode).
import { decompressWitnessStack, executeProgram, WitnessMap } from "@noir-lang/acvm_js"
import { abiDecode } from "@noir-lang/noirc_abi"
import {
    buildZkPresentationInputs,
    ZkCredentialCircuit,
    ZkPresentationInputs,
    zkPresentationInputsToWitness
} from "@coordination-network/credential"
import { createZkFixture, ZkFixture } from "./fixtures"

// The committed artifact is read by path rather than through @coordination-network/zk-artifacts:
// that package resolves its own files through import.meta.url, which ts-jest's CommonJS output
// cannot carry, which is why jest.config.ts excludes it from the projects it builds.
const CIRCUIT_PATH = resolve(__dirname, "../../zk-artifacts/credential/circuit.json")
const CIRCUIT = JSON.parse(readFileSync(CIRCUIT_PATH, "utf8")) as ZkCredentialCircuit
const WITNESS_LENGTH = 239

const base64Decode = (encoded: string): Uint8Array => Uint8Array.from(Buffer.from(encoded, "base64"))

// acvm_js's WitnessMap takes hex field-element strings (see its own WitnessMap
// doc comment), not the decimal strings zkPresentationInputsToWitness emits
// for a native prover — feeding it decimal strings missolves the circuit and
// fails "Cannot satisfy constraint" instead of erroring on the format, so
// this conversion is required here, not cosmetic.
const toHexField = (decimal: string): string => `0x${BigInt(decimal).toString(16).padStart(64, "0")}`

/** Sorted [index, decimal value] pairs, so two maps that differ only in key insertion order still compare equal. */
const normalize = (map: WitnessMap): [number, bigint][] =>
    [...map.entries()].sort(([a], [b]) => a - b).map(([index, value]) => [index, BigInt(value)])

describe("zkPresentationInputsToWitness", () => {
    let fixture: ZkFixture
    let inputs: ZkPresentationInputs

    beforeAll(async () => {
        fixture = await createZkFixture()
        inputs = await buildZkPresentationInputs(fixture.credential, fixture.holder, fixture.chain, fixture.request)
    })

    it("flattens to exactly 239 witnesses, ordered by the compiled ABI", () => {
        const witness = zkPresentationInputsToWitness(CIRCUIT.abi, inputs)

        expect(witness).toHaveLength(WITNESS_LENGTH)
        // public inputs
        expect(witness[0]).toBe(inputs.current_time)
        expect(witness[1]).toBe(inputs.challenge)
        expect(witness[2]).toBe(inputs.audience)
        expect(witness[3]).toBe(inputs.required_programme_hash)
        expect(witness[4]).toBe(inputs.required_country_code)
        // credential struct, in circuit field order (not JS key order)
        expect(witness.slice(5, 12)).toEqual([
            inputs.credential.programme_hash,
            inputs.credential.country_code,
            inputs.credential.not_before,
            inputs.credential.expires_at,
            inputs.credential.device_key_commitment,
            inputs.credential.holder_key_commitment,
            inputs.credential.revocation_commitment
        ])
        // issuer signature + Merkle path
        expect(witness.slice(12, 17)).toEqual([
            inputs.issuer_pub_x,
            inputs.issuer_pub_y,
            inputs.issuer_sig_r8_x,
            inputs.issuer_sig_r8_y,
            inputs.issuer_sig_s
        ])
        expect(witness[17]).toBe(inputs.issuer_depth)
        expect(witness.slice(18, 38)).toEqual(inputs.issuer_indices.map((bit) => (bit ? "1" : "0")))
        expect(witness.slice(38, 58)).toEqual(inputs.issuer_siblings)
        // [u8; 32] / [u8; 64] byte arrays, one witness per byte
        expect(witness.slice(58, 90)).toEqual(inputs.device_pub_x)
        expect(witness.slice(90, 122)).toEqual(inputs.device_pub_y)
        expect(witness.slice(122, 186)).toEqual(inputs.device_signature)
        // identity + revocation signatures
        expect(witness.slice(186, 191)).toEqual([
            inputs.identity_pub_x,
            inputs.identity_pub_y,
            inputs.identity_sig_r8_x,
            inputs.identity_sig_r8_y,
            inputs.identity_sig_s
        ])
        expect(witness.slice(191, 196)).toEqual([
            inputs.revocation_pub_x,
            inputs.revocation_pub_y,
            inputs.revocation_sig_r8_x,
            inputs.revocation_sig_r8_y,
            inputs.revocation_sig_s
        ])
        // revocation non-membership path
        expect(witness.slice(196, 198)).toEqual([inputs.revocation_low_leaf_value, inputs.revocation_low_leaf_next])
        expect(witness[198]).toBe(inputs.revocation_depth)
        expect(witness.slice(199, 219)).toEqual(inputs.revocation_indices.map((bit) => (bit ? "1" : "0")))
        expect(witness.slice(219, 239)).toEqual(inputs.revocation_siblings)
    })

    it("produces the same solved witness and return values as executing the structured inputs", async () => {
        const flattened = zkPresentationInputsToWitness(CIRCUIT.abi, inputs)

        const { witness: compressedStack, returnValue } = await new Noir(CIRCUIT).execute(inputs as unknown as InputMap)
        const structuredSolved = decompressWitnessStack(compressedStack)[0].witness

        const initialWitness: WitnessMap = new Map(flattened.map((value, index) => [index, toHexField(value)]))
        const stack = await executeProgram(base64Decode(CIRCUIT.bytecode), initialWitness, async (name) => {
            throw new Error(`unexpected foreign call: ${name}`)
        })
        const vectorSolved = stack[0].witness
        const { return_value: vectorReturnValue } = abiDecode(CIRCUIT.abi, vectorSolved) as {
            return_value: unknown
        }

        expect(normalize(vectorSolved)).toEqual(normalize(structuredSolved))
        expect(vectorReturnValue).toEqual(returnValue)
    })

    it("throws on an ABI parameter this input map does not have", () => {
        const abi = {
            parameters: [{ name: "not_a_real_field", type: { kind: "field" } }]
        } as unknown as ZkCredentialCircuit["abi"]

        expect(() => zkPresentationInputsToWitness(abi, inputs)).toThrow(/unknown ABI parameter/)
    })

    it("throws when an array input has the wrong length", () => {
        const changed = { ...inputs, issuer_indices: inputs.issuer_indices.slice(1) }

        expect(() => zkPresentationInputsToWitness(CIRCUIT.abi, changed)).toThrow(/issuer_indices/)
    })

    it("throws on an unparseable scalar", () => {
        const changed = { ...inputs, challenge: "not-a-field-element" }

        expect(() => zkPresentationInputsToWitness(CIRCUIT.abi, changed)).toThrow(/challenge/)
    })

    it("throws on a non-canonical scalar (leading zero)", () => {
        const changed = { ...inputs, challenge: `0${inputs.challenge}` }

        expect(() => zkPresentationInputsToWitness(CIRCUIT.abi, changed)).toThrow(/challenge/)
    })

    it("throws when a boolean array element is not a boolean", () => {
        const changed = {
            ...inputs,
            issuer_indices: [...inputs.issuer_indices.slice(0, -1), "true" as unknown as boolean]
        }

        expect(() => zkPresentationInputsToWitness(CIRCUIT.abi, changed)).toThrow(/issuer_indices\[19\]/)
    })

    it("throws on an ABI type this circuit's parameters never use", () => {
        const abi = {
            parameters: [{ name: "current_time", type: { kind: "tuple", fields: [] } }]
        } as unknown as ZkCredentialCircuit["abi"]

        expect(() => zkPresentationInputsToWitness(abi, inputs)).toThrow(/unsupported ABI type "tuple"/)
    })

    it("throws when the credential struct is missing", () => {
        const changed = { ...inputs, credential: undefined as unknown as ZkPresentationInputs["credential"] }

        expect(() => zkPresentationInputsToWitness(CIRCUIT.abi, changed)).toThrow(/credential/)
    })
})
