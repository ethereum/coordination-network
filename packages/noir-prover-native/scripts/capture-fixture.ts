/**
 * Captures the credential package's test presentation as this crate's fixtures, so a circuit ABI
 * change is a script run rather than a hand edit of 239 values.
 *
 *   node_modules/.bin/tsx packages/noir-prover-native/scripts/capture-fixture.ts
 */
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
    buildZkPresentationInputs,
    zkPresentationInputsToWitness,
    type ZkCredentialCircuit
} from "@coordination-network/credential"
import { getCredentialCircuit } from "@coordination-network/zk-artifacts"
import { createZkFixture } from "../../credential/tests/fixtures"

const here = resolve(import.meta.dirname, "..")
const toHex = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`
const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 4)}\n`)

async function main() {
    const circuit = (await getCredentialCircuit()) as ZkCredentialCircuit
    const fixture = await createZkFixture()
    const inputs = await buildZkPresentationInputs(fixture.credential, fixture.holder, fixture.chain, fixture.request)
    const witness = zkPresentationInputsToWitness(circuit.abi, inputs)
    const { currentTime, challenge, audience, programme, country } = fixture.request

    write(resolve(here, "rust/tests/credential-witness.json"), witness)
    write(resolve(here, "rust/tests/credential-expected.json"), {
        currentTime,
        challenge: toHex(challenge),
        audience,
        programme,
        country
    })
    console.info(`captured ${witness.length} witness values`)
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
