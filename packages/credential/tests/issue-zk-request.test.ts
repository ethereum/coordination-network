import { issueZkCredential, LocalCredentialSigner, programmeHash, countryCode } from "@coordination-network/credential"
import { createIssuanceFixture, OTHER_ISSUER_ID, signDevicePop } from "./fixtures"

describe("issueZkCredential request binding", () => {
    const signer = new LocalCredentialSigner("request-issuer")

    it("issues when the device signed this issuer and scope", async () => {
        const base = await createIssuanceFixture()
        const credential = await issueZkCredential(base.params, signer, base.resolver)

        expect(credential.body.programmeHash).toBe(programmeHash(base.params.approvalScope.programme))
        expect(credential.body.countryCode).toBe(countryCode(base.params.approvalScope.country))
    })

    it("refuses a binding signed for another issuer", async () => {
        const base = await createIssuanceFixture()

        await expect(
            issueZkCredential({ ...base.params, issuerNetworkId: OTHER_ISSUER_ID }, signer, base.resolver)
        ).rejects.toMatchObject({ code: "BINDING_INVALID" })
    })

    it.each([
        ["programme", { programme: "other-programme", country: "ZZZ" }],
        ["country", { programme: "test-programme", country: "XAA" }]
    ])("refuses a binding signed for another %s", async (_name, approvalScope) => {
        const base = await createIssuanceFixture()

        await expect(issueZkCredential({ ...base.params, approvalScope }, signer, base.resolver)).rejects.toMatchObject(
            {
                code: "BINDING_INVALID"
            }
        )
    })

    it("accepts the other approved issuer once the device signs for it", async () => {
        const base = await createIssuanceFixture()
        const devicePopSignature = await signDevicePop(
            base.deviceSigner,
            base.nonce,
            base.params.identityPublicKey,
            OTHER_ISSUER_ID,
            base.params.approvalScope
        )

        await expect(
            issueZkCredential(
                { ...base.params, issuerNetworkId: OTHER_ISSUER_ID, devicePopSignature },
                signer,
                base.resolver
            )
        ).resolves.toMatchObject({ body: { programmeHash: programmeHash(base.params.approvalScope.programme) } })
    })
})
