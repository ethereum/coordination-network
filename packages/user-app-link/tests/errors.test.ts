import { describe, it, expect } from "@jest/globals"
import { LinkDecodeError, LinkError, LinkPayloadTooLargeError } from "../src/errors"

describe("LinkError", () => {
    it("carries the given code and message", () => {
        const error = new LinkError("NO_CREDENTIAL", "no credential held")

        expect(error.name).toBe("LinkError")
        expect(error.code).toBe("NO_CREDENTIAL")
        expect(error.message).toBe("no credential held")
    })

    it("defaults the message to the code when none is given", () => {
        const error = new LinkError("PROOF_FAILED")

        expect(error.message).toBe("PROOF_FAILED")
    })
})

describe("LinkPayloadTooLargeError", () => {
    it("is a LinkError with code INVALID_REQUEST", () => {
        const error = new LinkPayloadTooLargeError("too big")

        expect(error).toBeInstanceOf(LinkError)
        expect(error.name).toBe("LinkPayloadTooLargeError")
        expect(error.code).toBe("INVALID_REQUEST")
        expect(error.message).toBe("too big")
    })
})

describe("LinkDecodeError", () => {
    it("is a LinkError with code INVALID_REQUEST", () => {
        const error = new LinkDecodeError("bad url")

        expect(error).toBeInstanceOf(LinkError)
        expect(error.name).toBe("LinkDecodeError")
        expect(error.code).toBe("INVALID_REQUEST")
        expect(error.message).toBe("bad url")
    })
})
