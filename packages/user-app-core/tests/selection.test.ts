import { describe, expect, it } from "@jest/globals"
import { latestExpiring, matchingCredentials } from "../src/selection"
import { fakeCredentialInfo } from "./support/fake-credential"

describe("matchingCredentials", () => {
    const request = { programme: "demo-programme", country: "ZZZ" }

    it("returns nothing when nothing is held", () => {
        expect(matchingCredentials([], request)).toEqual([])
    })

    it("returns nothing when no credential matches the requested programme/country", () => {
        const wrongProgramme = fakeCredentialInfo("a", "valid", { programme: "alt-programme" })
        const wrongCountry = fakeCredentialInfo("b", "valid", { country: "ZZY" })

        expect(matchingCredentials([wrongProgramme, wrongCountry], request)).toEqual([])
    })

    // Status is settled per issuer, after this narrowing: a caller that finds none valid still
    // has to tell "you hold a revoked one" from "you hold none at all".
    it("keeps a matching credential whatever its status", () => {
        const revoked = fakeCredentialInfo("a", "revoked")
        const expired = fakeCredentialInfo("b", "expired")
        const notYetValid = fakeCredentialInfo("c", "not-yet-valid")
        const issuerNotApproved = fakeCredentialInfo("d", "issuer-not-approved")

        expect(
            matchingCredentials([revoked, expired, notYetValid, issuerNotApproved], request).map((c) => c.id)
        ).toEqual(["a", "b", "c", "d"])
    })

    it("ignores a credential for a different programme or country alongside a match", () => {
        const match = fakeCredentialInfo("match", "valid")
        const otherProgramme = fakeCredentialInfo("other-programme", "valid", { programme: "alt-programme" })
        const otherCountry = fakeCredentialInfo("other-country", "valid", { country: "ZZY" })

        expect(matchingCredentials([match, otherProgramme, otherCountry], request)).toEqual([match])
    })

    it("carries whatever the caller attached to each credential through the filter", () => {
        const match = { ...fakeCredentialInfo("match", "valid"), issuer: "Member A" }

        expect(matchingCredentials([match], request)[0].issuer).toBe("Member A")
    })
})

describe("latestExpiring", () => {
    it("returns null when there is nothing to choose from", () => {
        expect(latestExpiring([])).toBeNull()
    })

    it("picks the sole candidate", () => {
        const only = fakeCredentialInfo("only", "valid")
        expect(latestExpiring([only])).toBe(only)
    })

    it("prefers the credential expiring latest", () => {
        const soon = fakeCredentialInfo("soon", "valid", { expiresAt: 100 })
        const later = fakeCredentialInfo("later", "valid", { expiresAt: 200 })

        expect(latestExpiring([soon, later])).toBe(later)
        expect(latestExpiring([later, soon])).toBe(later)
    })

    it("breaks an expiry tie deterministically by id", () => {
        const b = fakeCredentialInfo("b", "valid", { expiresAt: 100 })
        const a = fakeCredentialInfo("a", "valid", { expiresAt: 100 })

        expect(latestExpiring([b, a])).toBe(a)
        expect(latestExpiring([a, b])).toBe(a)
    })
})
