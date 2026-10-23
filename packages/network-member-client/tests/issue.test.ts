import { describe, expect, it, jest } from "@jest/globals"
import {
    IssuanceError,
    InMemoryResolver,
    LocalCredentialSigner,
    parseZkCredential,
    verifyZkCredential
} from "@coordination-network/credential"
import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { NetworkMemberClientError } from "../src/errors"
import { issueVC } from "../src/issue"
import { createIssueVCFixture, FakeIssuerSetReader } from "./fixtures"

describe("issueVC", () => {
    it("issues a credential and a witness that verifies against the set root", async () => {
        const { params, signer, resolver } = await createIssueVCFixture()
        const otherSigner = new LocalCredentialSigner("network-member-client-fixture-other-issuer")
        const issuerSetReader = new FakeIssuerSetReader([await signer.getPublicKey(), await otherSigner.getPublicKey()])

        const result = await issueVC(params, { signer, approval: resolver, issuerSetReader })

        expect(ApprovedIssuerSet.verifyProof(result.issuerMembershipWitness)).toBe(true)
        expect(result.issuerMembershipWitness.root).toBe(result.issuerSetRoot)
        expect(result.issuerMembershipWitness.leaf).toBe(ApprovedIssuerSet.leafOf(await signer.getPublicKey()))

        const expectedSet = await ApprovedIssuerSet.fromContract(issuerSetReader)
        expect(result.issuerSetRoot).toBe(expectedSet.root)

        const credential = parseZkCredential(result.credential)
        expect(verifyZkCredential(credential)).toBe(true)
    })

    it("passes through the issuance error for an unapproved issuer", async () => {
        const { params, signer } = await createIssueVCFixture()
        const resolver = new InMemoryResolver()
        const issuerSetReader = new FakeIssuerSetReader([await signer.getPublicKey()])

        const issuance = issueVC(params, { signer, approval: resolver, issuerSetReader })

        await expect(issuance).rejects.toThrow(IssuanceError)
        await expect(issuance).rejects.toMatchObject({ code: "ISSUER_NOT_APPROVED" })
    })

    it("throws ISSUER_KEY_NOT_PUBLISHED before the signer spends a signature", async () => {
        const { params, signer, resolver } = await createIssueVCFixture()
        const otherSigner = new LocalCredentialSigner("network-member-client-fixture-other-issuer")
        const issuerSetReader = new FakeIssuerSetReader([await otherSigner.getPublicKey()])
        const signSpy = jest.spyOn(signer, "sign")

        const issuance = issueVC(params, { signer, approval: resolver, issuerSetReader })

        await expect(issuance).rejects.toThrow(NetworkMemberClientError)
        await expect(issuance).rejects.toMatchObject({ code: "ISSUER_KEY_NOT_PUBLISHED" })
        expect(signSpy).not.toHaveBeenCalled()
    })
})
