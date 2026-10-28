import { verifyCredentialBinding } from "@coordination-network/identity"
import { InMemoryResolver } from "../src/resolver"
import { validateZkCredentialIssue } from "../src/issue-credential"
import { createIssuanceFixture, OTHER_ISSUER_ID, type IssuanceFixture } from "./fixtures"

jest.mock("@coordination-network/identity", () => {
    const actual = jest.requireActual<typeof import("@coordination-network/identity")>("@coordination-network/identity")
    return { ...actual, verifyCredentialBinding: jest.fn(actual.verifyCredentialBinding) }
})

describe("credential issuance validation failures", () => {
    let fixture: IssuanceFixture

    beforeAll(async () => {
        fixture = await createIssuanceFixture()
    })

    it("rejects an issuer not approved by the resolver", async () => {
        await expect(validateZkCredentialIssue(fixture.params, new InMemoryResolver())).rejects.toMatchObject({
            code: "ISSUER_NOT_APPROVED"
        })
    })

    it.each([0, -1])("rejects a validity window whose duration is %i", async (duration) => {
        await expect(
            validateZkCredentialIssue(
                { ...fixture.params, validUntil: fixture.params.validFrom + duration },
                fixture.resolver
            )
        ).rejects.toMatchObject({
            code: "INVALID_PARAMS",
            message: "validFrom must be before validUntil"
        })
    })

    it("reports malformed binding inputs as INVALID_PARAMS", async () => {
        await expect(
            validateZkCredentialIssue({ ...fixture.params, nonce: new Uint8Array(31) }, fixture.resolver)
        ).rejects.toMatchObject({
            code: "INVALID_PARAMS",
            message: expect.stringContaining("malformed binding input")
        })
    })

    it("preserves an unexpected binding verifier failure", async () => {
        const failure = new Error("verifier unavailable")
        jest.mocked(verifyCredentialBinding).mockImplementationOnce(() => {
            throw failure
        })
        await expect(validateZkCredentialIssue(fixture.params, fixture.resolver)).rejects.toBe(failure)
    })

    it("rejects a subject identifier that does not match the bound account", async () => {
        await expect(
            validateZkCredentialIssue({ ...fixture.params, subjectNetworkId: OTHER_ISSUER_ID }, fixture.resolver)
        ).rejects.toMatchObject({
            code: "SUBJECT_MISMATCH"
        })
    })

    it("rejects a tampered holder ownership signature even with a valid account/device binding", async () => {
        const signature = fixture.params.identityOwnershipSignature
        await expect(
            validateZkCredentialIssue(
                { ...fixture.params, identityOwnershipSignature: { ...signature, S: signature.S + 1n } },
                fixture.resolver
            )
        ).rejects.toMatchObject({
            code: "HOLDER_KEY_OWNERSHIP_INVALID"
        })
    })
})
