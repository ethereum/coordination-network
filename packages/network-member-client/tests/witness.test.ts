import { describe, expect, it } from "@jest/globals"
import { LocalCredentialSigner } from "@coordination-network/credential"
import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { NetworkMemberClientError } from "../src/errors"
import { fetchIssuerMembershipWitness } from "../src/witness"
import { FakeIssuerSetReader } from "./fixtures"

describe("fetchIssuerMembershipWitness", () => {
    it("follows the set's root as keys are published, and stales the old witness", async () => {
        const signerA = new LocalCredentialSigner("witness-fixture-a")
        const signerB = new LocalCredentialSigner("witness-fixture-b")
        const keyA = await signerA.getPublicKey()
        const keyB = await signerB.getPublicKey()

        const readerWithA = new FakeIssuerSetReader([keyA])
        const first = await fetchIssuerMembershipWitness({ issuerSetReader: readerWithA, issuerPublicKey: keyA })
        expect(ApprovedIssuerSet.verifyProof(first.witness)).toBe(true)
        expect(first.witness.root).toBe(first.root)

        const readerWithBoth = new FakeIssuerSetReader([keyA, keyB])
        const second = await fetchIssuerMembershipWitness({ issuerSetReader: readerWithBoth, issuerPublicKey: keyA })
        expect(second.root).not.toBe(first.root)
        expect(ApprovedIssuerSet.verifyProof(second.witness)).toBe(true)

        const rebuiltSet = await ApprovedIssuerSet.fromContract(readerWithBoth)
        expect(rebuiltSet.verifyProof(first.witness)).toBe(false)
    })

    it("throws ISSUER_KEY_NOT_PUBLISHED when the key is not in the set", async () => {
        const published = new LocalCredentialSigner("witness-fixture-published")
        const unpublished = new LocalCredentialSigner("witness-fixture-unpublished")
        const reader = new FakeIssuerSetReader([await published.getPublicKey()])

        const lookup = fetchIssuerMembershipWitness({
            issuerSetReader: reader,
            issuerPublicKey: await unpublished.getPublicKey()
        })

        await expect(lookup).rejects.toThrow(NetworkMemberClientError)
        await expect(lookup).rejects.toMatchObject({ code: "ISSUER_KEY_NOT_PUBLISHED" })
    })
})
