/**
 * Cross-checks a proof this crate produced against the SDK verifier the member server runs.
 * A native prover is only useful if `verifyZkPresentationProof` accepts its output unchanged.
 *
 *   node_modules/.bin/tsx packages/noir-prover-native/scripts/verify-native-proof.ts [proof.json]
 *
 * Without an argument it checks the proof `cargo test` wrote to rust/target/native-proof.json.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
    verifyZkPresentationProof,
    type ExpectedZkPresentation,
    type ZkCredentialCircuit,
    type ZkPresentationProof
} from "@coordination-network/credential"
import { getCredentialCircuit } from "@coordination-network/zk-artifacts"

const here = resolve(import.meta.dirname, "..")
const read = (path: string) => JSON.parse(readFileSync(path, "utf8"))
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value.replace(/^0x/, ""), "hex"))

async function main() {
    const circuit = (await getCredentialCircuit()) as ZkCredentialCircuit
    const raw = read(resolve(here, "rust/tests/credential-expected.json"))
    const expected: ExpectedZkPresentation = { ...raw, challenge: fromHex(raw.challenge) }
    const document = read(process.argv[2] ?? resolve(here, "rust/target/native-proof.json"))

    const proof: ZkPresentationProof = { proof: fromHex(document.proof), publicInputs: document.publicInputs }
    const started = Date.now()
    const result = await verifyZkPresentationProof(circuit, proof, expected)

    console.info(
        JSON.stringify(
            {
                proofBytes: proof.proof.length,
                publicInputs: proof.publicInputs.length,
                verifyMs: Date.now() - started,
                result
            },
            (_key, value) => (typeof value === "bigint" ? value.toString() : value),
            2
        )
    )
    process.exit(result.ok ? 0 : 1)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
