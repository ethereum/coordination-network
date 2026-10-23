import { policyForMember, programmeForMember } from "../src/business/policy"

describe("reference business policy", () => {
    it("accepts enrolment", async () =>
        expect(policyForMember("alpha").decideEnrolment("network-id")).resolves.toBe(true))

    it("gives Alpha a standard access programme in Demo Country", async () =>
        expect(policyForMember("alpha").decideIssuance("network-id")).resolves.toEqual({
            programme: "standard-access",
            country: "ZZZ"
        }))

    it("gives Beta a extended access programme in Demo Country A", async () =>
        expect(policyForMember("beta").decideIssuance("network-id")).resolves.toEqual({
            programme: "extended-access",
            country: "XAA"
        }))

    it("provides matching display names", () =>
        expect(programmeForMember("beta")).toEqual({
            programme: "extended-access",
            programmeName: "Extended Access",
            country: "XAA",
            countryName: "Demo Country A"
        }))
})
