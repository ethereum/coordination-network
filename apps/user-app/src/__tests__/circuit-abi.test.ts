import { readFileSync } from "fs"
import { resolve } from "path"
import credentialCircuit from "../generated/credential-abi.json"

// `scripts/sync-assets.sh` generates this file. It once wrapped the ABI in an envelope, which the
// prover adapter's type assertion hid: `parameters` was undefined and nothing failed until a proof
// ran on a device. This asserts the shape the adapter actually reads.
describe("the generated credential ABI", () => {
    it("exposes abi.parameters and a circuit hash where the prover looks for them", () => {
        expect(Array.isArray(credentialCircuit.abi.parameters)).toBe(true)
        expect(credentialCircuit.abi.parameters.length).toBeGreaterThan(0)
        expect(typeof credentialCircuit.hash).toBe("string")
    })

    it("names the circuit's public inputs, so the witness walk has something to order by", () => {
        const names = credentialCircuit.abi.parameters.map((parameter) => parameter.name)
        expect(names).toContain("current_time")
        expect(names).toContain("challenge")
        expect(names).toContain("credential")
    })

    it("matches the circuit asset to the installed zk-artifacts package", () => {
        const npmCircuit = require.resolve("@coordination-network/zk-artifacts/credential/circuit.json", {
            paths: [resolve(__dirname, "../..")]
        })
        const synced = readFileSync(resolve(__dirname, "../../assets/credential.noir"))
        expect(synced.equals(readFileSync(npmCircuit))).toBe(true)
    })
})
