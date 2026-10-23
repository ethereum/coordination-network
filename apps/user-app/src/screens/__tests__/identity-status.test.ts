import { registrationStatus } from "../identity-status"

describe("registrationStatus", () => {
    it("asks to configure the stack first", () => {
        expect(registrationStatus({ hasStack: false, registered: null, chainUnreachable: false })).toEqual({
            label: "Configure the stack",
            tone: "neutral"
        })
    })

    it("shows a checking state while the chain read is in flight", () => {
        expect(registrationStatus({ hasStack: true, registered: null, chainUnreachable: false })).toEqual({
            label: "Checking…",
            tone: "neutral"
        })
    })

    it("reports registered once the registry has an entry", () => {
        expect(registrationStatus({ hasStack: true, registered: true, chainUnreachable: false })).toEqual({
            label: "Registered",
            tone: "accent"
        })
    })

    it("reports not registered when the registry entry is empty", () => {
        expect(registrationStatus({ hasStack: true, registered: false, chainUnreachable: false })).toEqual({
            label: "Not registered",
            tone: "warning"
        })
    })

    it("reports chain unreachable instead of checking forever", () => {
        expect(registrationStatus({ hasStack: true, registered: null, chainUnreachable: true })).toEqual({
            label: "Chain unreachable",
            tone: "warning"
        })
    })

    it("reports chain unreachable even once a registration value has already arrived", () => {
        expect(registrationStatus({ hasStack: true, registered: true, chainUnreachable: true })).toEqual({
            label: "Chain unreachable",
            tone: "warning"
        })
    })
})
