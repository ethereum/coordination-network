import assert from "node:assert/strict"
import test from "node:test"
import {
    ZkCredentialProofSystem,
    type ZkCredentialCircuit,
    type ZkPresentationVerifyResult
} from "@coordination-network/credential"
import { Wallet, WalletError } from "@coordination-network/wallet"
import { getCredentialCircuit } from "@coordination-network/zk-artifacts"
import { CREDENTIAL_ID, issueForTest, VALID_AT } from "./fixtures"

test("wallet issues, stores, proves, verifies, then blocks a revoked credential", { timeout: 180_000 }, async () => {
    const fixture = await issueForTest()
    const circuit = (await getCredentialCircuit()) as ZkCredentialCircuit
    const proofSystem = await ZkCredentialProofSystem.create(circuit, { backend: { threads: 1 } })
    let consentCalls = 0
    const wallet = new Wallet({
        identitySeed: fixture.identitySeed,
        deviceSigner: fixture.deviceSigner,
        consent: async () => {
            consentCalls += 1
            return true
        },
        loadChainState: async () => fixture.chain,
        proofGenerator: proofSystem,
        now: () => VALID_AT * 1_000
    })

    try {
        await wallet.addCredential({
            id: CREDENTIAL_ID,
            credential: fixture.credential,
            revocationSecret: fixture.revocationSecret
        })

        const proof = await wallet.present(CREDENTIAL_ID, fixture.request, async () => fixture.chain)
        const verification: ZkPresentationVerifyResult = await proofSystem.verifyProof(proof, fixture.request)

        assert.deepEqual(verification, {
            ok: true,
            approvedIssuerRoot: fixture.chain.approvedIssuerRoot,
            revocationRoot: fixture.chain.revocationRoot
        })
        assert.equal(consentCalls, 1)

        const held = await wallet.getCredential(CREDENTIAL_ID)
        assert.notEqual(held, null)
        fixture.chain.revocations.revoke(held!.credential.body.revocationCommitment)
        fixture.chain.revocationRoot = fixture.chain.revocations.root
        await wallet.syncRevocations()

        await assert.rejects(
            wallet.present(CREDENTIAL_ID, fixture.request, async () => fixture.chain),
            (error) => error instanceof WalletError && error.code === "REVOKED"
        )
        assert.equal(consentCalls, 1)
    } finally {
        await proofSystem.destroy()
    }
})
