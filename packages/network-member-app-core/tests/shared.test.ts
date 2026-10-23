import { describe, expect, it, jest } from "@jest/globals"
import { runHook } from "../src/flows/shared"

describe("runHook", () => {
    it("is a no-op when no hook is registered", async () => {
        const onError = jest.fn((): void => {})

        await runHook({ onError }, "enrol", "registrations", undefined)

        expect(onError).not.toHaveBeenCalled()
    })
})
