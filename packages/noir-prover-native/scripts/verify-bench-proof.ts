/**
 * Verifies a device proof of a bench circuit that has no SDK verifier (SHA-256, ECDSA), with the
 * oracle the harness proves with (poseidon2, bb.js's default).
 *
 *   tsx verify-bench-proof.ts <circuit.json> <proof.json> [expected]
 *
 * `expected` checks the circuit's public outputs after the proof verifies: a 64-digit hex digest
 * for the 32 byte outputs of SHA-256, or `true` for the boolean output of ECDSA. Exits 1 when the
 * proof is rejected or an output differs.
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"

// bb.js is a dependency of the credential package; this one has none of its own.
const requireFromCredential = createRequire(resolve(import.meta.dirname, "../../credential/package.json"))

const field = (hex: string) => BigInt(hex)

function outputsMatch(publicInputs: string[], expected: string): boolean {
    if (expected === "true") {
        return publicInputs.length === 1 && field(publicInputs[0]) === 1n
    }
    if (!/^[0-9a-f]{64}$/i.test(expected)) {
        throw new Error(`expected must be a 64-digit hex digest or "true", got ${expected}`)
    }
    const digest = publicInputs.map((value) => field(value).toString(16).padStart(2, "0")).join("")
    return (
        publicInputs.length === 32 &&
        publicInputs.every((value) => field(value) < 256n) &&
        digest === expected.toLowerCase()
    )
}

async function main() {
    const [circuitPath, proofPath, expected] = process.argv.slice(2)
    if (!circuitPath || !proofPath) {
        throw new Error("usage: verify-bench-proof.ts <circuit.json> <proof.json> [expected]")
    }
    const { Barretenberg, UltraHonkBackend } = await import(requireFromCredential.resolve("@aztec/bb.js"))
    const circuit = JSON.parse(readFileSync(circuitPath, "utf8"))
    const document = JSON.parse(readFileSync(proofPath, "utf8")) as { proof: string; publicInputs: string[] }

    const api = await Barretenberg.new()
    const backend = new UltraHonkBackend(circuit.bytecode, api)
    const started = Date.now()
    const verified: boolean = await backend.verifyProof({
        proof: Uint8Array.from(Buffer.from(document.proof.replace(/^0x/, ""), "hex")),
        publicInputs: document.publicInputs
    })
    const outputs = expected === undefined ? undefined : outputsMatch(document.publicInputs, expected)
    await api.destroy()

    console.info(
        JSON.stringify({
            proofBytes: (document.proof.length - 2) / 2,
            publicInputs: document.publicInputs.length,
            verifyMs: Date.now() - started,
            verified,
            outputsMatch: outputs
        })
    )
    process.exit(verified && outputs !== false ? 0 : 1)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
