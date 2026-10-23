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
})
