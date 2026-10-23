import { describe, it, expect } from "@jest/globals"
import { UserClientError, SubmissionFailedError, RegistryReadFailedError } from "../src/errors"

describe("SubmissionFailedError", () => {
    it("captures an optional cause and is a UserClientError", () => {
        const cause = new Error("rpc timeout")
        const error = new SubmissionFailedError("submission failed", cause)

        expect(error).toBeInstanceOf(UserClientError)
        expect(error).toBeInstanceOf(SubmissionFailedError)
        expect(error.name).toBe("SubmissionFailedError")
        expect(error.code).toBe("SUBMISSION_FAILED")
        expect(error.cause).toBe(cause)
    })

    it("allows an omitted cause", () => {
        const error = new SubmissionFailedError("submission failed")

        expect(error.cause).toBeUndefined()
    })

    it("keeps cause non-enumerable, so logging a circular provider error cannot throw", () => {
        const providerError: Record<string, unknown> = { url: "https://rpc.example/v1/KEY" }
        providerError.self = providerError

        const error = new SubmissionFailedError("submit failed", providerError)

        expect(error.cause).toBe(providerError)
        expect(Object.keys(error)).not.toContain("cause")
        expect(() => JSON.stringify(error)).not.toThrow()
    })
})

describe("RegistryReadFailedError", () => {
    it("captures an optional cause and is a UserClientError", () => {
        const cause = new Error("rpc timeout")
        const error = new RegistryReadFailedError("registry read failed", cause)

        expect(error).toBeInstanceOf(UserClientError)
        expect(error).toBeInstanceOf(RegistryReadFailedError)
        expect(error.name).toBe("RegistryReadFailedError")
        expect(error.code).toBe("REGISTRY_READ_FAILED")
        expect(error.cause).toBe(cause)
    })

    it("allows an omitted cause", () => {
        const error = new RegistryReadFailedError("registry read failed")

        expect(error.cause).toBeUndefined()
    })

    it("keeps cause non-enumerable, so logging a circular provider error cannot throw", () => {
        const providerError: Record<string, unknown> = { url: "https://rpc.example/v1/KEY" }
        providerError.self = providerError

        const error = new RegistryReadFailedError("read failed", providerError)

        expect(error.cause).toBe(providerError)
        expect(Object.keys(error)).not.toContain("cause")
        expect(() => JSON.stringify(error)).not.toThrow()
    })
})
