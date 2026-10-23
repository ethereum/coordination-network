import { describe, expect, it, jest } from "@jest/globals"
import type { CredentialIssueParams, PresentationCreateParams } from "@coordination-network/user-app-link"
import { ApprovedIssuerSet, internalNode } from "@coordination-network/issuer-set"
import { RevocationRegistry, SNARK_SCALAR_FIELD } from "@coordination-network/revocation-registry"
import { writeIssuerEntry } from "../src/issuer-index"
import { createUserAppService } from "../src/service"
import type { ChainRoots } from "../src/types"
import { createServiceHarness, type ServiceHarness } from "./support/harness"
import { createMemberStack, type MemberStack } from "./support/member-stack"

const CALLER = { name: "test-verifier", scheme: "testverifier" }
const APPROVAL_SCOPE = { programme: "demo-programme", country: "ZZZ" }
const CHALLENGE = `0x${"0d".repeat(31)}` as const

function issueParams(issuer: MemberStack): CredentialIssueParams {
    return {
        issuerNetworkId: issuer.issuerNetworkId,
        approvalScope: APPROVAL_SCOPE,
        challengeUrl: issuer.challengeUrl,
        credentialsUrl: issuer.credentialsUrl,
        issuersUrl: issuer.issuersUrl,
        revocationsUrl: issuer.revocationsUrl
    }
}

function presentationParams(
    verifier: Pick<MemberStack, "issuersUrl" | "revocationsUrl" | "verifyUrl">
): PresentationCreateParams {
    return {
        requestId: "req-1",
        challenge: CHALLENGE,
        audience: "urn:cn:network:verifier",
        currentTime: Math.floor(Date.now() / 1000),
        programme: APPROVAL_SCOPE.programme,
        country: APPROVAL_SCOPE.country,
        issuersUrl: verifier.issuersUrl,
        revocationsUrl: verifier.revocationsUrl,
        responseUrl: verifier.verifyUrl
    }
}

/** Issued at stack 1, verified by stack 2: the shape of every cross-member check in the demo. */
async function twoMembers(): Promise<{
    harness: ServiceHarness
    issuer: MemberStack
    verifier: MemberStack
    credentialId: string
}> {
    const harness = createServiceHarness()
    await harness.service.createIdentity()
    const now = () => harness.now.value
    // One tree for the network: whichever member serves it, the wallet reads the same revocations.
    const revocations = new RevocationRegistry()
    const issuer = await createMemberStack(harness.http, { now, revocations })
    const verifier = await createMemberStack(harness.http, { now, revocations })

    // Each member's approved-issuer set names both, as the demo's chain-backed set does.
    issuer.approvedIssuerKeys.push(await verifier.credentialSigner.getPublicKey())
    verifier.approvedIssuerKeys.push(await issuer.credentialSigner.getPublicKey())

    harness.roots.read = async () => issuer.chainRoots()
    const issued = await harness.service.handlers["credential.issue"]!(issueParams(issuer), { caller: CALLER })
    const credentialId = issued.status === "stored" ? issued.credentialId : ""
    expect(credentialId).not.toBe("")
    harness.roots.read = async () => verifier.chainRoots()

    return { harness, issuer, verifier, credentialId }
}

/** Two issuers and a separate verifier, all on the one network tree: the wallet holds two credentials. */
async function threeMembers(): Promise<{
    harness: ServiceHarness
    issuerA: MemberStack
    issuerB: MemberStack
    verifier: MemberStack
    credentialIdA: string
}> {
    const harness = createServiceHarness()
    await harness.service.createIdentity()
    const now = () => harness.now.value
    const revocations = new RevocationRegistry()
    const issuerA = await createMemberStack(harness.http, { now, revocations })
    const issuerB = await createMemberStack(harness.http, { now, revocations })
    const verifier = await createMemberStack(harness.http, { now, revocations })
    verifier.approvedIssuerKeys.push(await issuerA.credentialSigner.getPublicKey())
    verifier.approvedIssuerKeys.push(await issuerB.credentialSigner.getPublicKey())

    harness.roots.read = async () => issuerA.chainRoots()
    const issuedA = await harness.service.handlers["credential.issue"]!(issueParams(issuerA), { caller: CALLER })
    harness.roots.read = async () => issuerB.chainRoots()
    const issuedB = await harness.service.handlers["credential.issue"]!(issueParams(issuerB), { caller: CALLER })
    harness.roots.read = async () => verifier.chainRoots()
    const credentialIdA = issuedA.status === "stored" ? issuedA.credentialId : ""
    expect(credentialIdA).not.toBe("")
    expect(issuedB.status).toBe("stored")

    return { harness, issuerA, issuerB, verifier, credentialIdA }
}

const present = (harness: ServiceHarness, verifier: MemberStack) =>
    harness.service.handlers["presentation.create"]!(presentationParams(verifier), { caller: CALLER })

describe("presentation.create", () => {
    it("proves the held credential and returns only the verifier's verification id", async () => {
        const { harness, verifier } = await twoMembers()

        const result = await present(harness, verifier)

        expect(result).toEqual({ verificationId: [...verifier.verifications.keys()][0] })
        expect(harness.proofGenerator.inputs).toHaveLength(1)
        const posted = harness.http.posts.filter(({ url }) => url === verifier.verifyUrl)
        expect(posted).toHaveLength(1)
        expect(posted[0].body).toMatchObject({ requestId: "req-1", proof: "0x01020304", publicInputs: ["1", "2", "3"] })
    })

    // Which snapshot the wallet reads used to identify the issuer to whoever served it. One tree
    // ends that: the verifier serves the same revocations every other member does.
    it("reads the revocation snapshot from the verifier, never from the credential's issuer", async () => {
        const { harness, issuer, verifier } = await twoMembers()
        harness.http.gets.length = 0

        await present(harness, verifier)

        expect(harness.http.gets).toContain(verifier.revocationsUrl)
        expect(harness.http.gets).not.toContain(issuer.revocationsUrl)
    })

    it("refuses with CREDENTIAL_REVOKED once the issuing member revokes it, and posts nothing", async () => {
        const { harness, issuer, verifier, credentialId } = await twoMembers()
        await expect(present(harness, verifier)).resolves.toBeDefined()

        issuer.revoke(credentialId)
        harness.http.posts.length = 0

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "CREDENTIAL_REVOKED" })
        expect(harness.http.posts).toEqual([])
    })

    // "This person holds a revoked credential" is a fact about the person, and the member that asked
    // writes it to a public activity log. The refusal goes through the same gate the proof does.
    it("asks before telling the verifier that the credential it asked about was revoked", async () => {
        const { harness, issuer, verifier, credentialId } = await twoMembers()
        issuer.revoke(credentialId)
        harness.reviewSeen.length = 0

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "CREDENTIAL_REVOKED" })

        expect(harness.reviewSeen).toEqual([
            {
                kind: "revoked",
                verifier: "urn:cn:network:verifier",
                programme: APPROVAL_SCOPE.programme,
                country: APPROVAL_SCOPE.country,
                issuerNetworkId: issuer.issuerNetworkId
            }
        ])
    })

    it("refuses with CONSENT_DENIED, telling the verifier nothing, when that answer is no", async () => {
        const { harness, issuer, verifier, credentialId } = await twoMembers()
        issuer.revoke(credentialId)
        harness.reviewAnswer.value = false
        harness.http.posts.length = 0

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "CONSENT_DENIED" })
        expect(harness.http.posts).toEqual([])
    })

    it("refuses with NO_CREDENTIAL, distinguishable from a revoked one, when nothing matches", async () => {
        const { harness, verifier } = await twoMembers()

        await expect(
            harness.service.handlers["presentation.create"]!(
                { ...presentationParams(verifier), programme: "another-programme" },
                { caller: CALLER }
            )
        ).rejects.toMatchObject({ code: "NO_CREDENTIAL" })
        expect(harness.proofGenerator.inputs).toEqual([])
    })

    // An entry whose credential is gone names a snapshot for nothing; it cannot be proved, and it
    // must not stop the credential that can be.
    it("ignores an issuer entry whose credential the wallet no longer holds", async () => {
        const { harness, verifier } = await twoMembers()
        await writeIssuerEntry(harness.store, `0x${"ee".repeat(32)}`, {
            credentialId: "urn:uuid:long-gone",
            issuerPublicKey: ["1", "2"],
            issuersUrl: "https://gone.example/v1/issuers",
            programme: APPROVAL_SCOPE.programme,
            country: APPROVAL_SCOPE.country,
            issuedAt: 0
        })

        await expect(present(harness, verifier)).resolves.toBeDefined()
        expect(harness.http.gets).not.toContain("https://gone.example/v1/revocations/snapshot")
    })

    // Selection must still pick the valid credential when the wallet holds a revoked one from
    // another issuer, and tell the person which member issued the one being proved.
    it("with two matching credentials from two issuers, one revoked: proves the valid one and names its issuer to review", async () => {
        const { harness, verifier, issuerA, issuerB, credentialIdA } = await threeMembers()
        issuerA.revoke(credentialIdA)

        const result = await present(harness, verifier)

        expect(result).toEqual({ verificationId: [...verifier.verifications.keys()][0] })
        expect(harness.reviewSeen[harness.reviewSeen.length - 1]).toMatchObject({
            issuerNetworkId: issuerB.issuerNetworkId
        })
    })

    // Both lists are the verifier's and the same for every candidate, so the request reads each
    // once however many credentials it has to weigh.
    it("reads the verifier's two lists once, however many candidates it syncs", async () => {
        const { harness, verifier, issuerA, issuerB } = await threeMembers()
        harness.http.gets.length = 0

        await present(harness, verifier)

        expect(harness.http.gets).toEqual([verifier.issuersUrl, verifier.revocationsUrl])
        expect(harness.http.gets).not.toContain(issuerA.revocationsUrl)
        expect(harness.http.gets).not.toContain(issuerB.revocationsUrl)
    })

    // Proving used to re-sync the selected credential so the wallet would hold its issuer's state;
    // the wallet now takes that state as an argument, so the second read has nothing left to do.
    it("reads the verifier's lists once and nothing more before proving", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.gets.length = 0

        await present(harness, verifier)

        expect(harness.http.gets).toEqual([verifier.issuersUrl, verifier.revocationsUrl])
    })

    it("asks the person once more after proving, naming what the verifier learns", async () => {
        const { harness, issuer, verifier } = await twoMembers()

        await present(harness, verifier)

        expect(harness.reviewSeen).toEqual([
            {
                kind: "proof",
                verifier: "urn:cn:network:verifier",
                programme: APPROVAL_SCOPE.programme,
                country: APPROVAL_SCOPE.country,
                issuerNetworkId: issuer.issuerNetworkId
            }
        ])
    })

    it("refuses with CONSENT_DENIED, before proving and before posting, when that review says no", async () => {
        const { harness, verifier } = await twoMembers()
        harness.reviewAnswer.value = false
        harness.deviceKey.calls.length = 0

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "CONSENT_DENIED" })
        expect(harness.proofGenerator.inputs).toHaveLength(0)
        expect(harness.deviceKey.calls).toEqual([])
        expect(harness.http.posts.some(({ url }) => url === verifier.verifyUrl)).toBe(false)
    })

    it("blames the verifier when the issuer set it serves differs from the chain's, whatever root it claims", async () => {
        const { harness, verifier } = await twoMembers()
        const chainRoots = verifier.chainRoots()
        const leaves = new ApprovedIssuerSet(verifier.approvedIssuerKeys).leafSlots.map(String)
        harness.http.onGet(verifier.issuersUrl, () => ({
            status: 200,
            body: { leaves: leaves.slice(1), root: chainRoots.approvedIssuerRoot.toString() }
        }))

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
        expect(harness.reviewSeen).toEqual([])
    })

    it("maps a chain-state failure to VERIFIER_UNREACHABLE, not INTERNAL", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onGet(verifier.issuersUrl, () => ({ status: 503, body: {} }))

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
    })

    // One member's server being down said nothing about the other's, but it used to end the request
    // for both - and blamed the verifier, which was up.
    // An issuer being down no longer costs the person anything: nothing in a presentation reads it.
    it("proves while the credential's own issuer is unreachable", async () => {
        const { harness, issuer, verifier } = await twoMembers()
        harness.http.onGet(issuer.revocationsUrl, () => {
            throw new Error("ECONNREFUSED")
        })
        harness.http.onGet(issuer.issuersUrl, () => {
            throw new Error("ECONNREFUSED")
        })

        await expect(present(harness, verifier)).resolves.toBeDefined()
    })

    // The verifier serves the only tree the request reads, so it alone can make it unanswerable.
    it("blames the verifier when its revocation snapshot cannot be read", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onGet(verifier.revocationsUrl, () => ({ status: 503, body: {} }))

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
        expect(harness.proofGenerator.inputs).toEqual([])
    })

    it("reports a raw prover failure as PROOF_FAILED", async () => {
        const { harness, verifier } = await twoMembers()
        harness.proofGenerator.generateProof = async () => {
            throw new Error("prover crashed")
        }

        await expect(present(harness, verifier)).rejects.toMatchObject({
            code: "PROOF_FAILED",
            message: "prover crashed"
        })
    })

    it("reports a raw non-Error prover throw as PROOF_FAILED with a generic message", async () => {
        const { harness, verifier } = await twoMembers()
        harness.proofGenerator.generateProof = async () => {
            throw "prover exploded"
        }

        await expect(present(harness, verifier)).rejects.toMatchObject({
            code: "PROOF_FAILED",
            message: "proof generation failed"
        })
    })

    it("maps a device-signer failure (a WalletError) to PROOF_FAILED", async () => {
        const { harness, verifier } = await twoMembers()
        harness.deviceKey.signerFor = () => ({
            getPublicKeyJwk: () => harness.deviceKey.getPublicKeyJwk(),
            sign: async () => {
                throw new Error("device locked")
            },
            signDigest: async () => {
                throw new Error("device locked")
            }
        })

        await expect(present(harness, verifier)).rejects.toMatchObject({
            code: "PROOF_FAILED",
            message: "device locked"
        })
    })

    it("maps an unreachable verifier to VERIFIER_UNREACHABLE", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onPost(verifier.verifyUrl, () => {
            throw new Error("ECONNREFUSED")
        })

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
    })

    it("maps a raw non-Error verifier-post throw to VERIFIER_UNREACHABLE with a generic message", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onPost(verifier.verifyUrl, () => {
            throw "socket exploded"
        })

        await expect(present(harness, verifier)).rejects.toMatchObject({
            code: "VERIFIER_UNREACHABLE",
            message: `POST ${verifier.verifyUrl} failed`
        })
    })

    // The verifier reporting its own `ok` is no evidence; its member app reads the recorded
    // outcome under the id instead, so a response without one is unusable.
    it("maps a verifier response carrying no verification id to VERIFIER_UNREACHABLE", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onPost(verifier.verifyUrl, () => ({ status: 200, body: { ok: false, code: "UNKNOWN_REQUEST" } }))

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
    })

    // An issuer refusing is the issuer declining to serve this person, and the wallet relays it in
    // the issuer's own words. A verifier has nothing to decline: it answered a request the wallet
    // made, so an error body from it is just an unusable answer.
    it("does not relay a verifier's own error body as a refusal", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onPost(verifier.verifyUrl, () => ({
            status: 400,
            body: { error: "unknown presentation request", code: "UNKNOWN_REQUEST" }
        }))

        await expect(present(harness, verifier)).rejects.toMatchObject({
            code: "VERIFIER_UNREACHABLE",
            message: `${verifier.verifyUrl} returned an unusable response`
        })
    })

    it("maps a non-200 verifier response to VERIFIER_UNREACHABLE even with an otherwise well-formed body", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onPost(verifier.verifyUrl, () => ({
            status: 500,
            body: { verificationId: "urn:uuid:should-not-be-used" }
        }))

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
    })

    it("requires onboarding", async () => {
        const harness = createServiceHarness()
        const verifier = await createMemberStack(harness.http, { now: () => harness.now.value })

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "NOT_ONBOARDED" })
    })
})

describe("presentation.create and the chain's roots", () => {
    it("proceeds when the served roots are garbage but the lists match the chain", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onGet(verifier.issuersUrl, () => ({
            status: 200,
            body: { leaves: new ApprovedIssuerSet(verifier.approvedIssuerKeys).leafSlots.map(String), root: "1" }
        }))
        harness.http.onGet(verifier.revocationsUrl, () => ({
            status: 200,
            body: { root: "1", snapshot: verifier.revocations.export() }
        }))

        await expect(present(harness, verifier)).resolves.toBeDefined()
    })

    // The verifier cannot revoke a credential the chain has not: its snapshot has to hash to the
    // chain's root, and a different tree does not.
    it("refuses VERIFIER_UNREACHABLE, flipping nothing, when the verifier serves a snapshot revoking the held credential", async () => {
        const { harness, issuer, verifier } = await twoMembers()
        const [{ revocationCommitment: commitment }] = [...issuer.issued.values()]
        const fake = new RevocationRegistry([commitment])
        // Its own root beside it, so trusting the served root would let this through.
        harness.http.onGet(verifier.revocationsUrl, () => ({
            status: 200,
            body: { root: fake.root.toString(), snapshot: fake.export() }
        }))
        harness.reviewSeen.length = 0
        harness.http.posts.length = 0

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
        expect(harness.reviewSeen).toEqual([])
        expect(harness.http.posts).toEqual([])
        expect((await harness.service.listCredentials())[0].status).toBe("valid")
    })

    // `c + p` hashes like `c`, so the snapshot matches the chain's root while hiding the revocation.
    it("refuses VERIFIER_UNREACHABLE, with no review and no post, when the verifier hides a revocation behind an aliased leaf", async () => {
        const { harness, issuer, verifier, credentialId } = await twoMembers()
        issuer.revoke(credentialId)
        const [{ revocationCommitment: commitment }] = [...issuer.issued.values()]
        const snapshot = JSON.parse(verifier.revocations.export()) as { leaves: { value: string }[] }
        const leaf = snapshot.leaves.find((candidate) => candidate.value === commitment.toString())
        if (leaf === undefined) throw new Error("the revoked commitment is not a leaf")
        leaf.value = (commitment + SNARK_SCALAR_FIELD).toString()
        harness.http.onGet(verifier.revocationsUrl, () => ({
            status: 200,
            body: { snapshot: JSON.stringify(snapshot) }
        }))
        harness.reviewSeen.length = 0
        harness.http.posts.length = 0

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
        expect(harness.reviewSeen).toEqual([])
        expect(harness.http.posts).toEqual([])
    })

    // An internal node stands in for the leaves under it, so the collapsed list has the chain's root;
    // only the leaf count tells them apart. Without it the verifier learns which side of the cut the
    // issuer is on, since a folded-away issuer leaf reads as not approved.
    it("refuses VERIFIER_UNREACHABLE, with no review and no post, when the verifier serves a collapsed issuer list", async () => {
        const { harness, verifier } = await twoMembers()
        const [first, second] = new ApprovedIssuerSet(verifier.approvedIssuerKeys).leafSlots
        const collapsed = [internalNode(first, second)]
        expect(ApprovedIssuerSet.fromLeaves(collapsed).root).toBe(verifier.chainRoots().approvedIssuerRoot)
        harness.http.onGet(verifier.issuersUrl, () => ({ status: 200, body: { leaves: collapsed.map(String) } }))
        harness.reviewSeen.length = 0
        harness.http.posts.length = 0

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
        expect(harness.reviewSeen).toEqual([])
        expect(harness.http.posts).toEqual([])
        expect((await harness.service.listCredentials())[0].status).toBe("valid")
    })

    it.each<[string, (roots: ChainRoots) => ChainRoots]>([
        ["issuer set", (roots) => ({ ...roots, approvedIssuerRoot: 1n })],
        ["revocation snapshot", (roots) => ({ ...roots, revocationRoot: 1n })]
    ])(
        "refuses VERIFIER_UNREACHABLE, with no review and no post, when the served %s is not the chain's",
        async (_, diverge) => {
            const { harness, verifier } = await twoMembers()
            harness.roots.read = async () => diverge(verifier.chainRoots())
            harness.reviewSeen.length = 0
            harness.http.posts.length = 0

            await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
            expect(harness.reviewSeen).toEqual([])
            expect(harness.http.posts).toEqual([])
        }
    )

    it("refuses CHAIN_UNREACHABLE, withholding the read's text and building no proof, when the roots cannot be read", async () => {
        const { harness, verifier } = await twoMembers()
        harness.roots.read = async () => {
            throw new Error("HTTP request failed. URL: https://rpc.example/v2/secret-key")
        }

        const error = await present(harness, verifier).catch((caught: Error) => caught)

        expect(error).toMatchObject({ code: "CHAIN_UNREACHABLE" })
        expect((error as Error).message).not.toContain("secret-key")
        expect(harness.proofGenerator.inputs).toEqual([])
    })

    it("refuses VERIFIER_UNREACHABLE, not CHAIN_UNREACHABLE, with no proof, when the lists and the roots both fail", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onGet(verifier.issuersUrl, () => ({ status: 503, body: {} }))
        harness.roots.read = async () => {
            throw new Error("connect ECONNREFUSED")
        }

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
        expect(harness.proofGenerator.inputs).toEqual([])
    })

    it("refuses VERIFIER_UNREACHABLE with fixed text when the lists fail with something that is not an Error", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.onGet(verifier.revocationsUrl, () => {
            throw "connection reset"
        })

        await expect(present(harness, verifier)).rejects.toMatchObject({
            code: "VERIFIER_UNREACHABLE",
            message: "the verifier's lists are unreadable"
        })
        expect(harness.proofGenerator.inputs).toEqual([])
    })

    it("reads the roots once per request, however many credentials it checks", async () => {
        const { harness, verifier } = await threeMembers()
        const read = jest.fn(async () => verifier.chainRoots())
        harness.roots.read = read

        await present(harness, verifier)

        expect(read).toHaveBeenCalledTimes(1)
    })

    it("does not read the chain when nothing held matches the request", async () => {
        const { harness, verifier } = await twoMembers()
        const read = jest.fn(async () => verifier.chainRoots())
        harness.roots.read = read

        await expect(
            harness.service.handlers["presentation.create"]!(
                { ...presentationParams(verifier), programme: "another-programme" },
                { caller: CALLER }
            )
        ).rejects.toMatchObject({ code: "NO_CREDENTIAL" })
        expect(read).not.toHaveBeenCalled()
    })
})

describe("presentation.create and the device keys", () => {
    it("reviews before the device is asked to sign", async () => {
        const { harness, verifier } = await twoMembers()
        const order: string[] = []
        const review = harness.ports.review
        harness.ports.review = async (summary) => {
            order.push("review")
            return review(summary)
        }
        const signerFor = harness.deviceKey.signerFor
        harness.deviceKey.signerFor = (prompt) => {
            const signer = signerFor(prompt)
            return {
                ...signer,
                signDigest: (digest) => {
                    order.push("signDigest")
                    return signer.signDigest(digest)
                }
            }
        }

        await present(harness, verifier)

        expect(order[0]).toBe("review")
        expect(order).toContain("signDigest")
    })

    it("raises the share prompt on the signature, naming the programme and country", async () => {
        const { harness, verifier } = await twoMembers()
        harness.deviceKey.prompts.length = 0

        await present(harness, verifier)

        expect(harness.deviceKey.prompts.length).toBeGreaterThan(0)
        for (const prompt of harness.deviceKey.prompts) {
            expect(prompt).toEqual({
                title: "Share a proof",
                subtitle: `Proves your ${APPROVAL_SCOPE.programme} credential (${APPROVAL_SCOPE.country})`
            })
        }
    })

    it("asks for the identity seed once, however many operations the process serves", async () => {
        const { harness, verifier } = await twoMembers()
        const restarted = createUserAppService(harness.ports)
        harness.deviceKey.calls.length = 0
        harness.deviceKey.prompts.length = 0

        await restarted.handlers["presentation.create"]!(presentationParams(verifier), { caller: CALLER })
        await restarted.handlers["presentation.create"]!(presentationParams(verifier), { caller: CALLER })

        expect(harness.deviceKey.calls.filter((call) => call === "ecdh")).toHaveLength(1)
        expect(harness.deviceKey.prompts[0]).toEqual({
            title: "Unlock your credentials",
            subtitle: "Needed once each time the app starts"
        })
    })

    it("maps a cancel at the signature to CONSENT_DENIED", async () => {
        const { harness, verifier } = await twoMembers()
        harness.deviceKey.failWith("signDigest", "USER_CANCELED")

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "CONSENT_DENIED" })
    })

    it("posts nothing and keeps the store as it was when the signature prompt is cancelled after an approved review", async () => {
        const { harness, verifier } = await twoMembers()
        const keysBefore = (await harness.store.list()).sort()
        harness.deviceKey.failWith("signDigest", "USER_CANCELED")

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "CONSENT_DENIED" })

        expect(harness.reviewSeen).toHaveLength(1)
        expect(harness.http.posts.some(({ url }) => url === verifier.verifyUrl)).toBe(false)
        expect((await harness.store.list()).sort()).toEqual(keysBefore)
        expect(await harness.service.listCredentials()).toHaveLength(1)
        // The next attempt is not poisoned by the cancel.
        await expect(present(harness, verifier)).resolves.toHaveProperty("verificationId")
    })

    it("does not re-prompt the unlock on a third operation after a cancelled one recovered", async () => {
        const { harness, verifier } = await twoMembers()
        const restarted = createUserAppService(harness.ports)
        const run = () => restarted.handlers["presentation.create"]!(presentationParams(verifier), { caller: CALLER })
        const ecdhCalls = () => harness.deviceKey.calls.filter((call) => call === "ecdh").length
        const before = ecdhCalls()
        harness.deviceKey.failWith("ecdh", "USER_CANCELED")

        await expect(run()).rejects.toMatchObject({ code: "CONSENT_DENIED" })
        await expect(run()).resolves.toHaveProperty("verificationId")
        await expect(run()).resolves.toHaveProperty("verificationId")

        expect(ecdhCalls() - before).toBe(2)
    })

    it("maps a cancel at the seed unlock to CONSENT_DENIED, and asks again next time", async () => {
        const { harness, verifier } = await twoMembers()
        const restarted = createUserAppService(harness.ports)
        harness.deviceKey.failWith("ecdh", "USER_CANCELED")

        await expect(
            restarted.handlers["presentation.create"]!(presentationParams(verifier), { caller: CALLER })
        ).rejects.toMatchObject({ code: "CONSENT_DENIED" })
        await expect(
            restarted.handlers["presentation.create"]!(presentationParams(verifier), { caller: CALLER })
        ).resolves.toHaveProperty("verificationId")
    })

    it("maps an invalidated key to INTERNAL", async () => {
        const { harness, verifier } = await twoMembers()
        harness.deviceKey.failWith("signDigest", "KEY_INVALIDATED")

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "INTERNAL" })
    })

    it("maps a failed authentication at the signature to INTERNAL, not PROOF_FAILED", async () => {
        const { harness, verifier } = await twoMembers()
        harness.deviceKey.failWith("signDigest", "AUTHENTICATION_FAILED")

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "INTERNAL" })
        expect(harness.http.posts.some(({ url }) => url === verifier.verifyUrl)).toBe(false)
    })
})

describe("presentation.create on a cold seed cache", () => {
    /** A restarted service over a store that already holds the credential, logging review into the key's call log. */
    async function coldStart(): Promise<{ harness: ServiceHarness; verifier: MemberStack; log: string[] }> {
        const { harness, verifier } = await twoMembers()
        const restarted = createUserAppService(harness.ports)
        harness.service = restarted
        const review = harness.ports.review
        harness.ports.review = async (summary) => {
            harness.deviceKey.calls.push("review")
            return review(summary)
        }
        harness.deviceKey.calls.length = 0
        return { harness, verifier, log: harness.deviceKey.calls }
    }

    it("asks for the review before unlocking the seed and before signing", async () => {
        const { harness, verifier, log } = await coldStart()

        await present(harness, verifier)

        expect(log.filter((call) => call !== "getPublicKeyJwk")).toEqual(["review", "ecdh", "signDigest"])
    })

    it("never unlocks the seed when the review is refused", async () => {
        const { harness, verifier, log } = await coldStart()
        harness.reviewAnswer.value = false

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "CONSENT_DENIED" })
        expect(log.filter((call) => call !== "getPublicKeyJwk")).toEqual(["review"])
    })
})

describe("same-device presentation connectivity", () => {
    it("does not retry a proof POST when the response is lost, and a new request can succeed", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.posts.length = 0
        const submit = jest.fn(() => {
            // The server might have consumed and verified this request already. The wallet cannot
            // infer either acceptance or rejection from a lost HTTP response.
            throw new Error("connection lost after submission")
        })
        harness.http.onPost(verifier.verifyUrl, submit)

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "VERIFIER_UNREACHABLE" })
        expect(submit).toHaveBeenCalledTimes(1)
        expect(harness.http.posts.filter(({ url }) => url === verifier.verifyUrl)).toHaveLength(1)

        harness.http.onPost(verifier.verifyUrl, () => ({
            status: 200,
            body: { verificationId: "urn:uuid:new-verification" }
        }))
        await expect(
            harness.service.handlers["presentation.create"]!(
                { ...presentationParams(verifier), requestId: "fresh-request" },
                { caller: CALLER }
            )
        ).resolves.toEqual({ verificationId: "urn:uuid:new-verification" })
        expect(harness.http.posts[harness.http.posts.length - 1]?.body).toMatchObject({ requestId: "fresh-request" })
    })

    it("posts no proof when the chain is offline, then succeeds after connectivity returns", async () => {
        const { harness, verifier } = await twoMembers()
        harness.http.posts.length = 0
        harness.proofGenerator.inputs.length = 0
        harness.roots.read = async () => {
            throw new Error("RPC offline")
        }

        await expect(present(harness, verifier)).rejects.toMatchObject({ code: "CHAIN_UNREACHABLE" })
        expect(harness.proofGenerator.inputs).toEqual([])
        expect(harness.http.posts).toEqual([])

        harness.roots.read = async () => verifier.chainRoots()
        await expect(present(harness, verifier)).resolves.toHaveProperty("verificationId")
    })
})
