import { describe, expect, it } from "@jest/globals"
import type { SubjectIdentity } from "@coordination-network/network-member-app-core"
import { APPROVAL_SCOPE, policy } from "../src/business/policy"
import { hex } from "./support"

const subject: SubjectIdentity = {
    networkId: hex(32, "11"),
    metaStealthAddress: hex(66, "22"),
    securityLevel: "SOFTWARE"
}

describe("business/policy", () => {
    it("always approves enrolment", async () => {
        expect(await policy.decideEnrolment(subject)).toEqual({ approved: true, value: undefined })
    })

    it("approves issuance from the subject alone, leaving what the wallet holds to the wallet", async () => {
        expect(await policy.decideIssuance(subject)).toEqual({ approved: true, value: APPROVAL_SCOPE })
    })
})
