// noir-prover-ffi cannot be dlopened under jest (there is no native module here), so this mock stands in
// for the native library and fails the way a real dlopen failure would. What that pins: the
// adapter never loads it at module scope, and the first proof is what loads it — the two halves of
// keeping a load failure a failed proof rather than a dead app.
const mockMoproFfiLoads = jest.fn()
jest.mock("@coordination-network/noir-prover-ffi", () => {
    mockMoproFfiLoads()
    throw new Error("dlopen failed")
})

jest.mock("expo-asset", () => ({
    Asset: { loadAsync: async () => [{ uri: "file:///fake/asset" }] }
}))

jest.mock("@react-native-async-storage/async-storage", () => ({
    getItem: async () => null,
    setItem: async () => {}
}))

// sync-assets.sh writes these, and .github/workflows/user-app.yml runs it before this test, but
// they're mocked anyway so the test stays fast and deterministic instead of depending on multi-
// megabyte files, and still passes locally before that script has ever run.
jest.mock("../../../assets/credential.noir", () => 1, { virtual: true })
jest.mock("../../../assets/g1-131073.dat", () => 2, { virtual: true })
jest.mock("../../generated/credential-abi.json", () => ({ abi: { parameters: [] }, hash: "test-hash" }), {
    virtual: true
})

import type { ZkPresentationInputs } from "@coordination-network/credential"
import { createProver } from "../prover"

/** The mocked ABI declares no parameters, so nothing here is read before the load fails. */
const inputs = {} as unknown as ZkPresentationInputs

describe("createProver", () => {
    beforeEach(() => {
        mockMoproFfiLoads.mockClear()
    })

    it("requires the adapter and creates a prover without importing noir-prover-ffi at module scope", async () => {
        const prover = await createProver()

        expect(prover).toBeDefined()
        expect(mockMoproFfiLoads).not.toHaveBeenCalled()
    })

    it("loads noir-prover-ffi on the first proof, so a load failure is a failed proof", async () => {
        const prover = await createProver()

        await expect(prover.generateProof(inputs)).rejects.toThrow("dlopen failed")
        expect(mockMoproFfiLoads).toHaveBeenCalledTimes(1)
    })
})
