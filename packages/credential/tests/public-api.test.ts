import * as credential from "../src"
import { Base8 } from "@zk-kit/baby-jubjub"
import { poseidon3 } from "poseidon-lite/poseidon3"

describe("public API", () => {
    it("reconstructs a published issuer set through the credential API", () => {
        const publicKey: [bigint, bigint] = [Base8[0], Base8[1]]
        // Consumers can rebuild the contract's leaf table using the domain exposed by credential.
        const leaf = poseidon3([credential.ISSUER_LEAF_DOMAIN, ...publicKey])
        const set = credential.ApprovedIssuerSet.fromLeaves([leaf])

        expect(set.isApproved(publicKey)).toBe(true)
        expect(credential.issuerLeaf(publicKey)).toBe(leaf)
        expect(set.generateProof(publicKey)).toMatchObject({ root: leaf, pathIndex: 0, siblings: [] })
    })

    it("does not expose the legacy SD-JWT credential path", () => {
        for (const name of [
            "issueSdJwtCredential",
            "decodeSdJwtCredentialClaims",
            "presentSdJwtCredential",
            "verifySdJwtCredential",
            "verifySdJwtPresentation"
        ]) {
            expect(credential).not.toHaveProperty(name)
        }
    })
})
