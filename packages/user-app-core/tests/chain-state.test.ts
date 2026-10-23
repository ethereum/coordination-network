import { describe, expect, it } from "@jest/globals"
import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { LocalCredentialSigner } from "@coordination-network/credential"
import { readLists } from "../src/chain-state"
import { FakeHttpClient } from "./support/fake-http"

describe("readLists", () => {
    const issuersUrl = "https://member.example/v1/issuers"
    const revocationsUrl = "https://member.example/v1/revocations/snapshot"

    it("rebuilds the approved-issuer set and the revocation registry from their URLs", async () => {
        const signer = new LocalCredentialSigner("chain-state-issuer")
        const key = await signer.getPublicKey()
        const approvedIssuers = new ApprovedIssuerSet([key])
        const revocations = new RevocationRegistry([7n])

        const http = new FakeHttpClient()
        http.onGet(issuersUrl, () => ({
            status: 200,
            body: { leaves: approvedIssuers.leafSlots.map(String) }
        }))
        http.onGet(revocationsUrl, () => ({ status: 200, body: { snapshot: revocations.export() } }))

        const lists = await readLists(http, issuersUrl, revocationsUrl)

        expect(lists.approvedIssuers.isApproved(key)).toBe(true)
        expect(lists.approvedIssuers.root).toBe(approvedIssuers.root)
        expect(lists.revocations.isRevoked(7n)).toBe(true)
        expect(lists.revocations.root).toBe(revocations.root)
    })

    it("ignores the roots the server serves beside its lists", async () => {
        const signer = new LocalCredentialSigner("chain-state-issuer-root")
        const key = await signer.getPublicKey()
        const approvedIssuers = new ApprovedIssuerSet([key])
        const revocations = new RevocationRegistry([7n])

        const http = new FakeHttpClient()
        http.onGet(issuersUrl, () => ({
            status: 200,
            body: { leaves: approvedIssuers.leafSlots.map(String), root: "not-a-bigint" }
        }))
        http.onGet(revocationsUrl, () => ({
            status: 200,
            body: { root: "not-a-bigint", snapshot: revocations.export() }
        }))

        const lists = await readLists(http, issuersUrl, revocationsUrl)

        expect(lists.approvedIssuers.root).toBe(approvedIssuers.root)
        expect(lists.revocations.root).toBe(revocations.root)
    })

    it("throws when the issuers endpoint does not answer 200", async () => {
        const http = new FakeHttpClient()
        http.onGet(issuersUrl, () => ({ status: 500, body: {} }))
        http.onGet(revocationsUrl, () => ({ status: 200, body: { snapshot: new RevocationRegistry().export() } }))

        await expect(readLists(http, issuersUrl, revocationsUrl)).rejects.toThrow(String(500))
    })

    it("throws when the revocations endpoint does not answer 200", async () => {
        const signer = new LocalCredentialSigner("chain-state-issuer-2")
        const key = await signer.getPublicKey()
        const approvedIssuers = new ApprovedIssuerSet([key])
        const http = new FakeHttpClient()
        http.onGet(issuersUrl, () => ({ status: 200, body: { leaves: approvedIssuers.leafSlots.map(String) } }))
        http.onGet(revocationsUrl, () => ({ status: 503, body: {} }))

        await expect(readLists(http, issuersUrl, revocationsUrl)).rejects.toThrow(String(503))
    })

    it("propagates a malformed issuers body (a leaf that isn't parseable as a bigint)", async () => {
        const http = new FakeHttpClient()
        http.onGet(issuersUrl, () => ({ status: 200, body: { leaves: ["not-a-bigint"] } }))
        http.onGet(revocationsUrl, () => ({ status: 200, body: { snapshot: new RevocationRegistry().export() } }))

        await expect(readLists(http, issuersUrl, revocationsUrl)).rejects.toThrow()
    })

    it("propagates a malformed revocation snapshot", async () => {
        const signer = new LocalCredentialSigner("chain-state-issuer-3")
        const key = await signer.getPublicKey()
        const approvedIssuers = new ApprovedIssuerSet([key])
        const http = new FakeHttpClient()
        http.onGet(issuersUrl, () => ({ status: 200, body: { leaves: approvedIssuers.leafSlots.map(String) } }))
        http.onGet(revocationsUrl, () => ({ status: 200, body: { snapshot: "not json" } }))

        await expect(readLists(http, issuersUrl, revocationsUrl)).rejects.toThrow()
    })
})
