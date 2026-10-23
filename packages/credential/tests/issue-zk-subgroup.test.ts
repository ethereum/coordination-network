import { SNARK_SCALAR_FIELD } from "@coordination-network/issuer-set"
import { Identity } from "@semaphore-protocol/identity"
import { bytesToHex } from "@noble/hashes/utils"
import { Base8 } from "@zk-kit/baby-jubjub"
import {
    EddsaPublicKey,
    issueZkCredential,
    LocalCredentialSigner,
    verifyCommitmentOwnership
} from "@coordination-network/credential"
import {
    createIssuanceFixture,
    lowOrderRevocation,
    mixedOrderRevocation,
    signDevicePop,
    ISSUER_ID,
    TORSION_8,
    withOrderTwoTorsion
} from "./fixtures"

type Fixture = Awaited<ReturnType<typeof createIssuanceFixture>>

describe("issueZkCredential key subgroup checks", () => {
    const signer = new LocalCredentialSigner("subgroup-issuer")

    function devicePop(base: Fixture, identityPublicKey: EddsaPublicKey) {
        return signDevicePop(base.deviceSigner, base.nonce, identityPublicKey, ISSUER_ID, base.params.approvalScope)
    }

    function holderOwnership(identity: Identity, nonce: Uint8Array) {
        const signature = identity.signMessage(BigInt(`0x${bytesToHex(nonce)}`))
        return { R8: [signature.R8[0], signature.R8[1]] as [bigint, bigint], S: signature.S }
    }

    it("rejects a mixed-order revocation key", async () => {
        const base = await createIssuanceFixture()
        const ownership = mixedOrderRevocation(base.r, base.nonce)
        const identity = new Identity("holder")
        const identityPublicKey = identity.publicKey
        const params = {
            ...base.params,
            identityPublicKey,
            identityOwnershipSignature: holderOwnership(identity, base.nonce),
            revocation: ownership,
            devicePopSignature: await devicePop(base, identityPublicKey)
        }

        expect(
            verifyCommitmentOwnership({
                commitment: ownership.commitment,
                publicKey: ownership.publicKey,
                signature: ownership.ownershipSignature,
                nonce: base.nonce
            })
        ).toBe(false)
        await expect(issueZkCredential(params, signer, base.resolver)).rejects.toMatchObject({
            code: "COMMITMENT_OWNERSHIP_INVALID"
        })
    })

    it("rejects an identity key that is not in the prime-order subgroup", async () => {
        const base = await createIssuanceFixture()
        const holder = new Identity("holder")
        const variant = withOrderTwoTorsion([holder.publicKey[0], holder.publicKey[1]])
        const devicePopSignature = await devicePop(base, variant)

        await expect(
            issueZkCredential({ ...base.params, identityPublicKey: variant, devicePopSignature }, signer, base.resolver)
        ).rejects.toMatchObject({
            code: "INVALID_PARAMS",
            message: expect.stringContaining("identity public key")
        })
    })

    it("rejects a low-order revocation key whose ownership signature needs no secret", async () => {
        const base = await createIssuanceFixture()
        const ownership = lowOrderRevocation()
        const identity = new Identity("holder")
        const identityPublicKey = identity.publicKey
        const params = {
            ...base.params,
            identityPublicKey,
            identityOwnershipSignature: holderOwnership(identity, base.nonce),
            revocation: ownership,
            devicePopSignature: await devicePop(base, identityPublicKey)
        }

        expect(
            verifyCommitmentOwnership({
                commitment: ownership.commitment,
                publicKey: TORSION_8,
                signature: ownership.ownershipSignature,
                nonce: base.nonce
            })
        ).toBe(false)
        await expect(issueZkCredential(params, signer, base.resolver)).rejects.toMatchObject({
            code: "COMMITMENT_OWNERSHIP_INVALID"
        })
    })

    it("rejects a low-order identity key", async () => {
        const base = await createIssuanceFixture()
        const devicePopSignature = await devicePop(base, TORSION_8)

        await expect(
            issueZkCredential(
                { ...base.params, identityPublicKey: TORSION_8, devicePopSignature },
                signer,
                base.resolver
            )
        ).rejects.toMatchObject({
            code: "INVALID_PARAMS",
            message: expect.stringContaining("identity public key")
        })
    })

    it.each([
        ["above the field", SNARK_SCALAR_FIELD],
        ["negative", -SNARK_SCALAR_FIELD]
    ])("rejects an identity key with a coordinate %s", async (_, offset) => {
        const base = await createIssuanceFixture()
        const [x, y] = Base8
        const devicePopSignature = await devicePop(base, Base8)

        await expect(
            issueZkCredential(
                { ...base.params, identityPublicKey: [x + offset, y], devicePopSignature },
                signer,
                base.resolver
            )
        ).rejects.toMatchObject({
            code: "INVALID_PARAMS",
            message: expect.stringContaining("identity public key")
        })
    })
})
