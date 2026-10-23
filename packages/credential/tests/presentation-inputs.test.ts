import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { p256 } from "@noble/curves/nist.js"
import { hexToBytes } from "@noble/hashes/utils"
import { Identity } from "@semaphore-protocol/identity"
import { poseidon4 } from "poseidon-lite/poseidon4"
import {
    ApprovedIssuerSet,
    buildZkPresentationInputs,
    issueZkCredential,
    IssuerSet,
    ISSUER_SET_MAX_DEPTH,
    LocalCredentialSigner,
    LocalP256Signer,
    parseZkCredential,
    PRESENTATION_DOMAIN,
    REVOCATION_MAX_DEPTH,
    verifyZkCredential,
    zkCredentialCommitment
} from "@coordination-network/credential"
import { createIssuanceFixture, createZkFixture, ISSUER_ID, signDevicePop, ZkFixture } from "./fixtures"

describe("ZK presentation inputs", () => {
    let fixture: ZkFixture

    beforeAll(async () => {
        fixture = await createZkFixture()
    })

    const build = () => buildZkPresentationInputs(fixture.credential, fixture.holder, fixture.chain, fixture.request)

    it("parses and verifies the issued credential", () => {
        const credential = parseZkCredential(fixture.credential)
        expect(verifyZkCredential(credential)).toBe(true)
        expect(zkCredentialCommitment(credential.body)).toBeGreaterThan(0n)
    })

    it.each([
        ["programmeHash", (value: ZkFixture["credential"]) => (value.body.programmeHash = "1")],
        ["countryCode", (value: ZkFixture["credential"]) => (value.body.countryCode = 1)],
        ["notBefore", (value: ZkFixture["credential"]) => (value.body.notBefore -= 1)],
        ["expiresAt", (value: ZkFixture["credential"]) => (value.body.expiresAt += 1)],
        ["deviceKeyCommitment", (value: ZkFixture["credential"]) => (value.body.deviceKeyCommitment = "1")],
        ["holderKeyCommitment", (value: ZkFixture["credential"]) => (value.body.holderKeyCommitment = "1")],
        ["revocationCommitment", (value: ZkFixture["credential"]) => (value.body.revocationCommitment = "1")]
    ])("rejects a changed signed %s", async (_name, mutate) => {
        const changed = structuredClone(fixture.credential)
        mutate(changed)
        expect(verifyZkCredential(parseZkCredential(changed))).toBe(false)
        await expect(
            buildZkPresentationInputs(changed, fixture.holder, fixture.chain, fixture.request)
        ).rejects.toThrow(/issuer signature/)
    })

    it("rejects non-canonical serialized values", () => {
        const changed = structuredClone(fixture.credential)
        changed.body.revocationCommitment = "01"
        expect(() => parseZkCredential(changed)).toThrow(/decimal/)
    })

    it("binds the holder commitment into the issuance device proof", async () => {
        const base = await createIssuanceFixture()
        const signedHolder = new Identity("signed-holder")
        const substitutedHolder = new Identity("substituted-holder")
        const devicePopSignature = await signDevicePop(
            base.deviceSigner,
            base.nonce,
            signedHolder.publicKey,
            ISSUER_ID,
            base.params.approvalScope
        )

        await expect(
            issueZkCredential(
                {
                    ...base.params,
                    devicePopSignature,
                    identityPublicKey: substitutedHolder.publicKey
                },
                new LocalCredentialSigner("test-issuer"),
                base.resolver
            )
        ).rejects.toMatchObject({ code: "BINDING_INVALID" })
    })

    it("emits the nested signed credential and both public predicates", async () => {
        const inputs = await build()
        const { body } = parseZkCredential(fixture.credential)

        expect(inputs.credential).toEqual({
            programme_hash: String(body.programmeHash),
            country_code: String(body.countryCode),
            not_before: String(body.notBefore),
            expires_at: String(body.expiresAt),
            device_key_commitment: String(body.deviceKeyCommitment),
            holder_key_commitment: String(body.holderKeyCommitment),
            revocation_commitment: String(body.revocationCommitment)
        })
        expect(inputs.required_programme_hash).toBe(inputs.credential.programme_hash)
        expect(inputs.required_country_code).toBe(inputs.credential.country_code)
    })

    it("builds and validates the private approved-issuer path", async () => {
        const inputs = await build()

        expect(inputs.issuer_depth).toBe(String(fixture.chain.approvedIssuers.depth))
        expect(inputs.issuer_indices).toHaveLength(ISSUER_SET_MAX_DEPTH)
        expect(inputs.issuer_siblings).toHaveLength(ISSUER_SET_MAX_DEPTH)
        expect(inputs.issuer_indices[0]).toBe(true)
    })

    it("gives a one-key approved-issuer set an issuer_depth of 0", async () => {
        const soleIssuer = new ApprovedIssuerSet([await fixture.credentialSigner.getPublicKey()])
        const chain = { ...fixture.chain, approvedIssuers: soleIssuer }

        const inputs = await buildZkPresentationInputs(fixture.credential, fixture.holder, chain, fixture.request)

        expect(inputs.issuer_depth).toBe("0")
        expect(inputs.issuer_indices).toHaveLength(ISSUER_SET_MAX_DEPTH)
        expect(inputs.issuer_siblings).toHaveLength(ISSUER_SET_MAX_DEPTH)
    })

    it("gives an issuer at a promoted slot 4 of a five-key set issuer_depth 1 and the four-key subtree root as its only sibling", async () => {
        const dummySigners = await Promise.all(
            ["a", "b", "c", "d"].map((label) =>
                new LocalCredentialSigner(`promoted-slot-dummy-${label}`).getPublicKey()
            )
        )
        const fourKeySubtree = new ApprovedIssuerSet(dummySigners)
        const actualIssuerKey = await fixture.credentialSigner.getPublicKey()
        const chain = {
            ...fixture.chain,
            approvedIssuers: new ApprovedIssuerSet([...dummySigners, actualIssuerKey])
        }

        const inputs = await buildZkPresentationInputs(fixture.credential, fixture.holder, chain, fixture.request)

        expect(inputs.issuer_depth).toBe("1")
        expect(inputs.issuer_indices[0]).toBe(true)
        expect(inputs.issuer_indices.slice(1).every((bit) => bit === false)).toBe(true)
        expect(inputs.issuer_siblings[0]).toBe(String(fourKeySubtree.root))
        expect(inputs.issuer_siblings.slice(1).every((sibling) => sibling === "0")).toBe(true)
    })

    it("gives an issuer at slot 0 of a five-key set issuer_depth 3", async () => {
        const dummySigners = await Promise.all(
            ["a", "b", "c", "d"].map((label) =>
                new LocalCredentialSigner(`promoted-slot-dummy-${label}`).getPublicKey()
            )
        )
        const actualIssuerKey = await fixture.credentialSigner.getPublicKey()
        const chain = {
            ...fixture.chain,
            approvedIssuers: new ApprovedIssuerSet([actualIssuerKey, ...dummySigners])
        }

        const inputs = await buildZkPresentationInputs(fixture.credential, fixture.holder, chain, fixture.request)

        expect(inputs.issuer_depth).toBe("3")
        expect(inputs.issuer_indices).toHaveLength(ISSUER_SET_MAX_DEPTH)
        expect(inputs.issuer_siblings).toHaveLength(ISSUER_SET_MAX_DEPTH)
    })

    it("rejects an issuer proof whose pathIndex is outside the packed range", async () => {
        const credential = parseZkCredential(fixture.credential)
        const validProof = fixture.chain.approvedIssuers.generateProof(credential.issuerPublicKey)
        const fakeIssuerSet: IssuerSet = {
            root: fixture.chain.approvedIssuers.root,
            generateProof: () => ({ ...validProof, pathIndex: 2 ** validProof.siblings.length })
        }
        const chain = { ...fixture.chain, approvedIssuers: fakeIssuerSet }

        await expect(
            buildZkPresentationInputs(fixture.credential, fixture.holder, chain, fixture.request)
        ).rejects.toThrow(/invalid path index/)
    })

    it("rejects an issuer proof whose sibling has been tampered with", async () => {
        const credential = parseZkCredential(fixture.credential)
        const validProof = fixture.chain.approvedIssuers.generateProof(credential.issuerPublicKey)
        const tamperedSiblings = [...validProof.siblings]
        tamperedSiblings[0] += 1n
        const fakeIssuerSet: IssuerSet = {
            root: fixture.chain.approvedIssuers.root,
            generateProof: () => ({ ...validProof, siblings: tamperedSiblings })
        }
        const chain = { ...fixture.chain, approvedIssuers: fakeIssuerSet }

        await expect(
            buildZkPresentationInputs(fixture.credential, fixture.holder, chain, fixture.request)
        ).rejects.toThrow(/issuer proof is invalid/)
    })

    it("rejects an issuer proof whose depth exceeds the circuit maximum", async () => {
        const credential = parseZkCredential(fixture.credential)
        const validProof = fixture.chain.approvedIssuers.generateProof(credential.issuerPublicKey)
        const tooDeepSiblings = Array.from({ length: ISSUER_SET_MAX_DEPTH + 1 }, () => 0n)
        const fakeIssuerSet: IssuerSet = {
            root: fixture.chain.approvedIssuers.root,
            generateProof: () => ({ ...validProof, siblings: tooDeepSiblings })
        }
        const chain = { ...fixture.chain, approvedIssuers: fakeIssuerSet }

        await expect(
            buildZkPresentationInputs(fixture.credential, fixture.holder, chain, fixture.request)
        ).rejects.toThrow("issuer path depth 21 exceeds the circuit maximum of 20")
    })

    it("refuses an issuer outside the approved set", async () => {
        const unapproved = new LocalCredentialSigner("unapproved-issuer")
        const chain = {
            ...fixture.chain,
            approvedIssuers: new ApprovedIssuerSet([await unapproved.getPublicKey()])
        }

        await expect(
            buildZkPresentationInputs(fixture.credential, fixture.holder, chain, fixture.request)
        ).rejects.toThrow(/approved set/)
    })

    it("signs one credential-bound session with the holder, revocation, and device keys", async () => {
        const inputs = await build()
        const credential = parseZkCredential(fixture.credential)
        const sessionMessage = poseidon4([
            PRESENTATION_DOMAIN,
            BigInt(inputs.challenge),
            BigInt(inputs.audience),
            zkCredentialCommitment(credential.body)
        ])

        const holderKey: [bigint, bigint] = [BigInt(inputs.identity_pub_x), BigInt(inputs.identity_pub_y)]
        expect(
            Identity.verifySignature(
                sessionMessage,
                {
                    R8: [BigInt(inputs.identity_sig_r8_x), BigInt(inputs.identity_sig_r8_y)],
                    S: BigInt(inputs.identity_sig_s)
                },
                holderKey
            )
        ).toBe(true)

        const revocationKey: [bigint, bigint] = [BigInt(inputs.revocation_pub_x), BigInt(inputs.revocation_pub_y)]
        expect(
            Identity.verifySignature(
                sessionMessage,
                {
                    R8: [BigInt(inputs.revocation_sig_r8_x), BigInt(inputs.revocation_sig_r8_y)],
                    S: BigInt(inputs.revocation_sig_s)
                },
                revocationKey
            )
        ).toBe(true)

        const deviceKey = Uint8Array.from([4, ...inputs.device_pub_x.map(Number), ...inputs.device_pub_y.map(Number)])
        const digest = hexToBytes(sessionMessage.toString(16).padStart(64, "0"))
        expect(p256.verify(Uint8Array.from(inputs.device_signature.map(Number)), digest, deviceKey)).toBe(true)
    })

    it.each([
        ["challenge", { challenge: hexToBytes("ab".repeat(31)) }],
        ["audience", { audience: "urn:cn:network:another-verifier" }]
    ])("binds the presentation to a fresh %s", async (_name, requestPatch) => {
        const first = await build()
        const second = await buildZkPresentationInputs(fixture.credential, fixture.holder, fixture.chain, {
            ...fixture.request,
            ...requestPatch
        })

        expect(second.identity_sig_s).not.toBe(first.identity_sig_s)
        expect(second.device_signature).not.toEqual(first.device_signature)
        expect(second.revocation_sig_s).not.toBe(first.revocation_sig_s)
    })

    it("refuses the wrong holder, revocation secret, or device signer", async () => {
        await expect(
            buildZkPresentationInputs(
                fixture.credential,
                { ...fixture.holder, identitySeed: hexToBytes("22".repeat(32)) },
                fixture.chain,
                fixture.request
            )
        ).rejects.toThrow(/holder-key/)
        await expect(
            buildZkPresentationInputs(
                fixture.credential,
                { ...fixture.holder, revocationSecret: hexToBytes("23".repeat(32)) },
                fixture.chain,
                fixture.request
            )
        ).rejects.toThrow(/revocation commitment/)
        await expect(
            buildZkPresentationInputs(
                fixture.credential,
                { ...fixture.holder, deviceSigner: LocalP256Signer.generate() },
                fixture.chain,
                fixture.request
            )
        ).rejects.toThrow(/device-key/)
    })

    it("pads the revocation path to the circuit depth", async () => {
        const inputs = await build()

        expect(inputs.revocation_indices).toHaveLength(REVOCATION_MAX_DEPTH)
        expect(inputs.revocation_siblings).toHaveLength(REVOCATION_MAX_DEPTH)
        expect(Number(inputs.revocation_depth)).toBeLessThanOrEqual(REVOCATION_MAX_DEPTH)
    })

    it("refuses a challenge that is not exactly 31 bytes", async () => {
        await expect(
            buildZkPresentationInputs(fixture.credential, fixture.holder, fixture.chain, {
                ...fixture.request,
                challenge: hexToBytes("ab".repeat(32))
            })
        ).rejects.toThrow(/31 bytes/)
    })

    it("refuses to build a presentation for a revoked credential", async () => {
        const revocations = new RevocationRegistry([parseZkCredential(fixture.credential).body.revocationCommitment])
        const chain = { ...fixture.chain, revocations }

        await expect(
            buildZkPresentationInputs(fixture.credential, fixture.holder, chain, fixture.request)
        ).rejects.toThrow(/revoked/)
    })

    it("builds the canonical witness for an empty revocation registry", async () => {
        const inputs = await buildZkPresentationInputs(
            fixture.credential,
            fixture.holder,
            { ...fixture.chain, revocations: new RevocationRegistry() },
            fixture.request
        )

        expect(inputs.revocation_depth).toBe("0")
        expect(inputs.revocation_low_leaf_value).toBe("0")
        expect(inputs.revocation_low_leaf_next).toBe("0")
    })
})
