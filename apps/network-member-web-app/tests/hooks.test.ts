import { createLoggingHooks, loggingHooks } from "../src/business/hooks"

describe("business event logging", () => {
    const info = jest.spyOn(console, "info").mockImplementation(() => undefined)

    beforeEach(() => info.mockClear())

    afterAll(() => info.mockRestore())

    it("logs only event status by default", () => {
        const sensitive = {
            credential: "complete-credential-secret",
            record: "complete-verification-record"
        }

        loggingHooks.onEvent("issuance", sensitive)

        expect(info).toHaveBeenCalledWith("[member] issuance")
        expect(JSON.stringify(info.mock.calls)).not.toContain(sensitive.credential)
        expect(JSON.stringify(info.mock.calls)).not.toContain(sensitive.record)
    })

    it("allows details only through an explicit development hook", () => {
        const details = { status: "local-development-only" }

        createLoggingHooks(true).onEvent("verification", details)

        expect(info).toHaveBeenCalledWith("[member] verification", details)
    })
})
