import { describe, expect, it } from "@jest/globals"
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub"
import {
    issuerLeaf as credentialIssuerLeaf,
    ApprovedIssuerSet as CredentialApprovedIssuerSet
} from "@coordination-network/credential"
import { ApprovedIssuerSet, issuerKeyLeaf } from "../src"
import type { IssuerPublicKey } from "../src"

/**
 * `packages/credential/src/issuer-set.ts` re-exports this package's `ApprovedIssuerSet` and
 * `issuerKeyLeaf` under the names `ApprovedIssuerSet` and `issuerLeaf`, so the circuit-mirror class
 * the SDK hands presentation code is, at runtime, this class. That re-export is the entire guarantee:
 * if it were ever edited into a wrapper or a divergent implementation, the credential layer would
 * silently start opening proofs against a different tree than the one pinned in this file and in
 * `packages/contracts/test/integration/IssuerSetCrossLanguageRoot.t.sol`. This test fails the moment
 * that stops being true.
 */

function key(k: number): IssuerPublicKey {
    return mulPointEscalar(Base8, BigInt(k)) as IssuerPublicKey
}

describe("credential drift guard", () => {
    it("issuerLeaf is the same function issuer-set exports", () => {
        expect(credentialIssuerLeaf).toBe(issuerKeyLeaf)
    })

    it("credential's ApprovedIssuerSet is issuer-set's ApprovedIssuerSet", () => {
        expect(CredentialApprovedIssuerSet).toBe(ApprovedIssuerSet)
    })

    it("produces the same root for the same keys", () => {
        const keys = [key(1), key(2), key(3)]

        const fromIssuerSet = new ApprovedIssuerSet(keys)
        const fromCredential = new CredentialApprovedIssuerSet(keys)

        expect(fromCredential.root).toBe(fromIssuerSet.root)
        expect(fromCredential.root).toBe(11334223563046274794300795549267186709638286758254539923752495560734019145426n)
    })
})
