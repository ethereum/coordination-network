import { describe, expect, it } from "@jest/globals"
import { Identity } from "@semaphore-protocol/identity"
import { deriveEddsaKeypair, eddsaPeerPointBytes, verifyCredentialBinding } from "@coordination-network/identity"
import { ApprovedIssuerSet, internalNode, issuerKeyLeaf } from "@coordination-network/issuer-set"
import {
    LocalCredentialSigner,
    countryCode,
    issuanceRequestCommitment,
    jwkToPublicKeyBytes,
    programmeHash,
    serializeZkCredential,
    zkCredentialCommitment,
    type Jwk,
    type ZkCredentialBody
} from "@coordination-network/credential"
import type { CredentialIssueParams } from "@coordination-network/user-app-link"
import { createUserAppService } from "../src/service"
import { bigintToBytes32, bytesToHex } from "../src/hex"
import { readIssuerEntry, writeIssuerEntry } from "../src/issuer-index"
import { createServiceHarness, type ServiceHarness } from "./support/harness"
import { sharedSecretFor } from "./support/test-device-key"
import { createMemberStack, type MemberStack } from "./support/member-stack"

const CALLER = { name: "test-member", scheme: "testmember" }
const APPROVAL_SCOPE = { programme: "demo-programme", country: "ZZZ" }

function issueParams(memberStack: MemberStack): CredentialIssueParams {
    return {
        issuerNetworkId: memberStack.issuerNetworkId,
        approvalScope: APPROVAL_SCOPE,
        challengeUrl: memberStack.challengeUrl,
        credentialsUrl: memberStack.credentialsUrl,
        issuersUrl: memberStack.issuersUrl,
        revocationsUrl: memberStack.revocationsUrl
    }
}

async function onboardedHarness(
    options: Parameters<typeof createServiceHarness>[0] = {}
): Promise<{ harness: ServiceHarness; memberStack: MemberStack }> {
    const harness = createServiceHarness(options)
    await harness.service.createIdentity()
    const memberStack = await createMemberStack(harness.http, { now: () => harness.now.value })
    harness.roots.read = async () => memberStack.chainRoots()
    return { harness, memberStack }
}

const issue = (harness: ServiceHarness, memberStack: MemberStack) =>
    harness.service.handlers["credential.issue"]!(issueParams(memberStack), { caller: CALLER })

const challenges = (harness: ServiceHarness, memberStack: MemberStack) =>
    harness.http.posts.filter(({ url }) => url === memberStack.challengeUrl)

const otherMemberKey = () => new LocalCredentialSigner("another-member").getPublicKey()

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function delayReads(harness: ServiceHarness, chainDelay: number, listDelay: number): void {
    const read = harness.directory.read
    harness.directory.read = async (networkId) => {
        await wait(chainDelay)
        return read(networkId)
    }
    const getJson = harness.http.getJson.bind(harness.http)
    harness.http.getJson = async (url) => {
        await wait(listDelay)
        return getJson(url)
    }
}

const storedId = (result: Awaited<ReturnType<typeof issue>>): string => {
    expect(result.status).toBe("stored")
    return result.status === "stored" ? result.credentialId : ""
}

describe("credential.issue", () => {
    it("runs the whole issuance and stores a credential a cold-restarted service reads back", async () => {
        const { harness, memberStack } = await onboardedHarness()

        const credentialId = storedId(await issue(harness, memberStack))
        expect(memberStack.issued.has(credentialId)).toBe(true)

        const restarted = createUserAppService(harness.ports)
        const held = await restarted.listCredentials()
        expect(held).toHaveLength(1)
        expect(held[0]).toMatchObject({
            id: credentialId,
            status: "valid",
            country: "ZZZ",
            programme: APPROVAL_SCOPE.programme,
            issuerNetworkId: memberStack.issuerNetworkId
        })
    })

    // The revocation secret lives only in this call's memory, so a failure after the 201 orphans
    // the credential at the issuer. The lists are read first to leave the local store as the only
    // step that can still fail once the issuer has signed.
    it("reports each step before it happens, with the lists read before the issuer signs", async () => {
        const { harness, memberStack } = await onboardedHarness()

        await issue(harness, memberStack)

        expect(harness.progressSeen.filter(({ op }) => op === "credential.issue").map(({ step }) => step)).toEqual([
            "Checking what you hold",
            "Checking the lists",
            "Getting a challenge",
            "Binding to this phone",
            "Asking the issuer to sign",
            "Saving to your wallet"
        ])
    })

    it("never asks the issuer to sign when its own lists cannot be read", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.http.onGet(memberStack.revocationsUrl, () => ({ status: 503, body: {} }))

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
        expect(harness.http.posts.some(({ url }) => url === memberStack.credentialsUrl)).toBe(false)
    })

    // issuerNetworkId comes from the caller, so a member could name another's id and have its own
    // key stored under it. The chain says which keys belong to the id.
    describe("binding the issuer key to the claimed member", () => {
        it("refuses ISSUER_NOT_APPROVED when the signing key is not among the claimed member's keys", async () => {
            const { harness, memberStack } = await onboardedHarness()
            const otherKey = await otherMemberKey()
            harness.directory.read = async () => [issuerKeyLeaf(otherKey)]

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_NOT_APPROVED" })

            expect(await harness.service.listCredentials()).toEqual([])
            expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toBeNull()
        })

        it("refuses ISSUER_NOT_APPROVED on an empty key list, before the challenge", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.directory.read = async () => []

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_NOT_APPROVED" })
            expect(challenges(harness, memberStack)).toHaveLength(0)
        })

        it("reports CHAIN_UNREACHABLE, with no challenge made, when the read throws", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.directory.read = async () => {
                throw new Error("connect ECONNREFUSED")
            }

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "CHAIN_UNREACHABLE" })
            expect(challenges(harness, memberStack)).toHaveLength(0)
        })

        it("keeps the read's own error text, which can carry an RPC URL, out of the response", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.directory.read = async () => {
                throw new Error("HTTP request failed. URL: https://rpc.example/v2/secret-key")
            }

            const error = await issue(harness, memberStack).catch((caught: Error) => caught)

            expect(error).toMatchObject({ code: "CHAIN_UNREACHABLE" })
            expect((error as Error).message).not.toContain("secret-key")
        })

        it("reads the claimed member's keys by the id the caller named", async () => {
            const { harness, memberStack } = await onboardedHarness()
            const asked: string[] = []
            const read = harness.directory.read
            harness.directory.read = async (networkId) => {
                asked.push(networkId)
                return read(networkId)
            }

            storedId(await issue(harness, memberStack))

            expect(asked).toEqual([memberStack.issuerNetworkId])
        })

        // An entry written before this check, or for a key since retired, would otherwise answer
        // alreadyHeld and leave the real member unable to issue.
        it("ignores a held entry whose key is not among the member's keys, and issues over it", async () => {
            const { harness, memberStack } = await onboardedHarness()
            const poisonedId = storedId(await issue(harness, memberStack))
            const otherKey = await otherMemberKey()
            const entry = await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)
            await writeIssuerEntry(harness.store, memberStack.issuerNetworkId, {
                ...entry!,
                issuerPublicKey: [otherKey[0].toString(), otherKey[1].toString()]
            })

            const second = await issue(harness, memberStack)

            expect(second.status).toBe("stored")
            expect(second.status === "stored" ? second.credentialId : "").not.toBe(poisonedId)
            expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toMatchObject({
                credentialId: second.status === "stored" ? second.credentialId : ""
            })
        })
    })

    describe("checking the served lists against the chain's roots", () => {
        it("refuses ISSUER_UNREACHABLE before any challenge when the served issuer set is not the chain's", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.roots.read = async () => ({ ...memberStack.chainRoots(), approvedIssuerRoot: 1n })

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
            expect(challenges(harness, memberStack)).toHaveLength(0)
            expect(await harness.service.listCredentials()).toEqual([])
        })

        it("refuses ISSUER_UNREACHABLE before any challenge when the served revocation snapshot is not the chain's", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.roots.read = async () => ({ ...memberStack.chainRoots(), revocationRoot: 1n })

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
            expect(challenges(harness, memberStack)).toHaveLength(0)
            expect(await harness.service.listCredentials()).toEqual([])
        })

        it("refuses ISSUER_UNREACHABLE, not INTERNAL, when a held entry's lists are not the chain's", async () => {
            const { harness, memberStack } = await onboardedHarness()
            storedId(await issue(harness, memberStack))
            const challengesBefore = challenges(harness, memberStack).length
            harness.roots.read = async () => ({ ...memberStack.chainRoots(), approvedIssuerRoot: 1n })

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
            expect(challenges(harness, memberStack)).toHaveLength(challengesBefore)
        })

        it("refuses ISSUER_UNREACHABLE before any challenge when the issuer serves a collapsed list with the chain's root", async () => {
            const { harness, memberStack } = await onboardedHarness()
            memberStack.approvedIssuerKeys.push(await otherMemberKey())
            const [first, second] = new ApprovedIssuerSet(memberStack.approvedIssuerKeys).leafSlots
            const collapsed = [internalNode(first, second)]
            expect(ApprovedIssuerSet.fromLeaves(collapsed).root).toBe(memberStack.chainRoots().approvedIssuerRoot)
            harness.http.onGet(memberStack.issuersUrl, () => ({ status: 200, body: { leaves: collapsed.map(String) } }))

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
            expect(challenges(harness, memberStack)).toHaveLength(0)
            expect(await harness.service.listCredentials()).toEqual([])
        })

        it("trusts the chain's roots over a root the issuer serves beside its lists", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.http.onGet(memberStack.issuersUrl, () => ({
                status: 200,
                body: { leaves: new ApprovedIssuerSet(memberStack.approvedIssuerKeys).leafSlots.map(String), root: "1" }
            }))

            expect((await issue(harness, memberStack)).status).toBe("stored")
        })

        it("reports CHAIN_UNREACHABLE, with no challenge made and the read's text withheld, when the roots cannot be read", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.roots.read = async () => {
                throw new Error("HTTP request failed. URL: https://rpc.example/v2/secret-key")
            }

            const error = await issue(harness, memberStack).catch((caught: Error) => caught)

            expect(error).toMatchObject({ code: "CHAIN_UNREACHABLE" })
            expect((error as Error).message).not.toContain("secret-key")
            expect(challenges(harness, memberStack)).toHaveLength(0)
        })
    })

    describe("a held entry", () => {
        it("reports CHAIN_UNREACHABLE, not alreadyHeld, when the chain cannot be read", async () => {
            const { harness, memberStack } = await onboardedHarness()
            storedId(await issue(harness, memberStack))
            harness.directory.read = async () => {
                throw new Error("connect ECONNREFUSED")
            }

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "CHAIN_UNREACHABLE" })
        })

        it("reports ISSUER_NOT_APPROVED, not alreadyHeld, when the member has no keys", async () => {
            const { harness, memberStack } = await onboardedHarness()
            storedId(await issue(harness, memberStack))
            harness.directory.read = async () => []

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_NOT_APPROVED" })
        })
    })

    describe("the two reads before the issuer signs", () => {
        it("reports ISSUER_UNREACHABLE, with no challenge made, when both reads fail", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.http.onGet(memberStack.issuersUrl, () => ({ status: 503, body: {} }))
            harness.directory.read = async () => {
                throw new Error("connect ECONNREFUSED")
            }

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
            expect(challenges(harness, memberStack)).toHaveLength(0)
        })

        // Each read settles in its own time; the verdict must not depend on which comes back first.
        it.each([
            ["the list fetch answers last", 0, 20],
            ["the chain read answers last", 20, 0]
        ])("stores the credential when %s", async (_name, chainDelay, listDelay) => {
            const { harness, memberStack } = await onboardedHarness()
            delayReads(harness, chainDelay, listDelay)

            expect((await issue(harness, memberStack)).status).toBe("stored")
        })

        it.each([
            ["the list fetch answers last", 0, 20],
            ["the chain read answers last", 20, 0]
        ])("reports CHAIN_UNREACHABLE when the read fails and %s", async (_name, chainDelay, listDelay) => {
            const { harness, memberStack } = await onboardedHarness()
            harness.directory.read = async () => {
                throw new Error("connect ECONNREFUSED")
            }
            delayReads(harness, chainDelay, listDelay)

            await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "CHAIN_UNREACHABLE" })
            expect(challenges(harness, memberStack)).toHaveLength(0)
        })

        // Case-folding is the index's job; the directory is asked in the caller's own spelling.
        it("passes a mixed-case issuer id to the directory as given and still finds the lowercase entry", async () => {
            const { harness, memberStack } = await onboardedHarness()
            const upperId =
                `0x${memberStack.issuerNetworkId.slice(2).toUpperCase()}` as typeof memberStack.issuerNetworkId
            const asked: string[] = []
            const read = harness.directory.read
            harness.directory.read = async (networkId) => {
                asked.push(networkId)
                return read(memberStack.issuerNetworkId)
            }
            const params = { ...issueParams(memberStack), issuerNetworkId: upperId }
            const credentialId = storedId(await issue(harness, memberStack))
            const postsAfterFirst = harness.http.posts.length

            const second = await harness.service.handlers["credential.issue"]!(params, { caller: CALLER })

            expect(asked).toEqual([memberStack.issuerNetworkId, upperId])
            expect(second).toEqual({ status: "alreadyHeld", credentialId })
            expect(harness.http.posts).toHaveLength(postsAfterFirst)
        })

        it("answers alreadyHeld, instead of issuing, after a retired entry has been replaced", async () => {
            const { harness, memberStack } = await onboardedHarness()
            storedId(await issue(harness, memberStack))
            const retiredKey = await new LocalCredentialSigner("retired-key").getPublicKey()
            const entry = await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)
            await writeIssuerEntry(harness.store, memberStack.issuerNetworkId, {
                ...entry!,
                issuerPublicKey: [retiredKey[0].toString(), retiredKey[1].toString()]
            })
            const replacedId = storedId(await issue(harness, memberStack))

            expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toMatchObject({
                credentialId: replacedId,
                issuerPublicKey: entry!.issuerPublicKey
            })
            expect(await issue(harness, memberStack)).toEqual({ status: "alreadyHeld", credentialId: replacedId })
        })

        // The issuer has signed by now and the secret is gone with the call, so nothing may be
        // left behind that suggests a credential is held.
        it("persists nothing, and names no secret, when the signing key turns out not to be approved", async () => {
            const { harness, memberStack } = await onboardedHarness()
            const otherKey = await otherMemberKey()
            harness.directory.read = async () => [issuerKeyLeaf(otherKey)]
            const keysBefore = (await harness.store.list()).sort()

            const error = await issue(harness, memberStack).catch((caught: Error) => caught)

            expect(error).toMatchObject({ code: "ISSUER_NOT_APPROVED" })
            expect(memberStack.issued.size).toBe(1)
            expect((await harness.store.list()).sort()).toEqual(keysBefore)
            expect(error).toHaveProperty(
                "message",
                `the credential is not signed by a key of ${memberStack.issuerNetworkId}`
            )
        })
    })

    describe("device attestation", () => {
        it("posts the signing key's attestation chain, and no self-reported security level", async () => {
            const { harness, memberStack } = await onboardedHarness()
            harness.deviceKey.attestationChain = ["bGVhZg==", "cm9vdA=="]
            harness.deviceKey.getSecurityLevel = async () => "STRONGBOX"

            await issue(harness, memberStack)

            const post = harness.http.posts.find(({ url }) => url === memberStack.credentialsUrl)
            expect(post?.body).toMatchObject({ deviceAttestation: ["bGVhZg==", "cm9vdA=="] })
            expect(post?.body).not.toHaveProperty("deviceSecurityLevel")
        })

        it("omits the field when the key has no chain", async () => {
            const { harness, memberStack } = await onboardedHarness()

            await issue(harness, memberStack)

            const post = harness.http.posts.find(({ url }) => url === memberStack.credentialsUrl)
            expect(post?.body).not.toHaveProperty("deviceAttestation")
            expect(post?.body).not.toHaveProperty("deviceSecurityLevel")
        })
    })

    // The issuer verifies these bindings itself before signing, so a successful issuance already
    // proves they hold; this pins that they bind *this* phone's identity to the issuer's own nonce.
    it("binds the credential to this phone against the nonce the issuer handed out", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const identity = await harness.service.readIdentity()

        await issue(harness, memberStack)

        const posted = harness.http.posts.find(({ url }) => url === memberStack.credentialsUrl)?.body as {
            accountPublicKey: `0x${string}`
            confirmationKey: Jwk
            devicePopSignature: `0x${string}`
            accountPopSignature: `0x${string}`
            identityPublicKey: [string, string]
        }
        const holderKeyCommitment = bigintToBytes32(
            Identity.generateCommitment([BigInt(posted.identityPublicKey[0]), BigInt(posted.identityPublicKey[1])])
        )

        const binding = verifyCredentialBinding({
            nonce: bytesToHex(memberStack.lastNonceFor(identity.networkId)),
            accountPublicKey: posted.accountPublicKey,
            confirmationKey: jwkToPublicKeyBytes(posted.confirmationKey),
            holderKeyCommitment,
            requestCommitment: issuanceRequestCommitment(memberStack.issuerNetworkId, APPROVAL_SCOPE),
            accountSignature: posted.accountPopSignature,
            deviceSignature: posted.devicePopSignature
        })

        expect(binding.valid).toBe(true)
        expect(binding.networkId).toBe(identity.networkId)
    })

    it("signs the issuer and scope the consent screen showed, so the signature fits no other", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const identity = await harness.service.readIdentity()
        await issue(harness, memberStack)
        const posted = harness.http.posts.find(({ url }) => url === memberStack.credentialsUrl)?.body as {
            accountPublicKey: `0x${string}`
            confirmationKey: Jwk
            devicePopSignature: `0x${string}`
            accountPopSignature: `0x${string}`
            identityPublicKey: [string, string]
        }
        const bindingFor = (requestCommitment: Uint8Array) =>
            verifyCredentialBinding({
                nonce: bytesToHex(memberStack.lastNonceFor(identity.networkId)),
                accountPublicKey: posted.accountPublicKey,
                confirmationKey: jwkToPublicKeyBytes(posted.confirmationKey),
                holderKeyCommitment: bigintToBytes32(
                    Identity.generateCommitment([
                        BigInt(posted.identityPublicKey[0]),
                        BigInt(posted.identityPublicKey[1])
                    ])
                ),
                requestCommitment,
                accountSignature: posted.accountPopSignature,
                deviceSignature: posted.devicePopSignature
            }).valid

        expect(bindingFor(issuanceRequestCommitment(memberStack.issuerNetworkId, APPROVAL_SCOPE))).toBe(true)
        expect(
            bindingFor(issuanceRequestCommitment(memberStack.issuerNetworkId, { ...APPROVAL_SCOPE, country: "XAA" }))
        ).toBe(false)
        expect(bindingFor(issuanceRequestCommitment(`0x${"ee".repeat(32)}`, APPROVAL_SCOPE))).toBe(false)
    })

    // An issuer that skips the binding check can still answer with a credential for other terms.
    it.each([
        ["programme", { programme: "other-programme", country: APPROVAL_SCOPE.country }],
        ["country", { programme: APPROVAL_SCOPE.programme, country: "XAA" }]
    ])("refuses a credential for a different %s and stores nothing", async (_name, scope) => {
        const { harness, memberStack } = await onboardedHarness()
        const body: ZkCredentialBody = {
            programmeHash: programmeHash(scope.programme),
            countryCode: countryCode(scope.country),
            notBefore: 1,
            expiresAt: 2,
            deviceKeyCommitment: 1n,
            holderKeyCommitment: 1n,
            revocationCommitment: 1n
        }
        const credential = serializeZkCredential({
            body,
            issuerPublicKey: await memberStack.credentialSigner.getPublicKey(),
            signature: await memberStack.credentialSigner.sign(zkCredentialCommitment(body))
        })
        harness.http.onPost(memberStack.credentialsUrl, () => ({ status: 201, body: { id: "cred-1", credential } }))

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
        expect(await harness.service.listCredentials()).toEqual([])
        expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toBeNull()
    })

    it("answers alreadyHeld, without asking for a second challenge, when this issuer already issued one", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const credentialId = storedId(await issue(harness, memberStack))
        const postsAfterFirst = harness.http.posts.length

        const second = await issue(harness, memberStack)

        expect(second).toEqual({ status: "alreadyHeld", credentialId })
        expect(harness.http.posts).toHaveLength(postsAfterFirst)
    })

    // One key per issuer meant a member could issue exactly one credential per wallet, ever. A member
    // runs more than one programme, and the same programme in more than one country.
    it("issues a second credential for another programme from the same issuer", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const first = storedId(await issue(harness, memberStack))

        const second = await harness.service.handlers["credential.issue"]!(
            { ...issueParams(memberStack), approvalScope: { programme: "alt-programme", country: "ZZZ" } },
            { caller: CALLER }
        )

        expect(second.status).toBe("stored")
        expect(second.status === "stored" ? second.credentialId : "").not.toBe(first)
        expect((await harness.service.listCredentials()).map(({ programme }) => programme).sort()).toEqual([
            "alt-programme",
            "demo-programme"
        ])
    })

    it("issues again once the credential it holds has been revoked", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const revokedId = storedId(await issue(harness, memberStack))
        memberStack.revoke(revokedId)

        const second = await issue(harness, memberStack)

        expect(second.status).toBe("stored")
        expect(second.status === "stored" ? second.credentialId : "").not.toBe(revokedId)
        expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toMatchObject({
            credentialId: second.status === "stored" ? second.credentialId : ""
        })
    })

    // An entry can outlive its credential, and one that names nothing is no reason to refuse.
    it("issues again when the entry names a credential the wallet no longer holds", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const goneId = storedId(await issue(harness, memberStack))
        await harness.store.delete(`vc:${goneId}`)

        const second = await issue(harness, memberStack)

        expect(second.status).toBe("stored")
        expect(second.status === "stored" ? second.credentialId : "").not.toBe(goneId)
    })

    it("issues again once the credential it holds has expired", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const expiredId = storedId(await issue(harness, memberStack))
        harness.now.value += 2 * 60 * 60 * 1000

        const second = await issue(harness, memberStack)

        expect(second.status).toBe("stored")
        expect(second.status === "stored" ? second.credentialId : "").not.toBe(expiredId)
    })

    it("writes the issuer index entry with the credential id, the issuer's own key, and the issuance time", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const credentialId = storedId(await issue(harness, memberStack))

        const issuerPublicKey = await memberStack.credentialSigner.getPublicKey()
        expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toEqual({
            credentialId,
            issuerPublicKey: [issuerPublicKey[0].toString(), issuerPublicKey[1].toString()],
            issuersUrl: memberStack.issuersUrl,
            programme: APPROVAL_SCOPE.programme,
            country: APPROVAL_SCOPE.country,
            issuedAt: Math.floor(harness.now.value / 1000)
        })
    })

    // Whether the held credential is still valid is the issuer's to say, so answering alreadyHeld
    // costs the two reads that say it - and nothing else, least of all a second signature.
    it("answers alreadyHeld after reading the issuer's two lists, and asks the issuer for nothing", async () => {
        const { harness, memberStack } = await onboardedHarness()
        await issue(harness, memberStack)
        const postsAfterFirst = harness.http.posts.length
        harness.http.gets.length = 0

        const second = await issue(harness, memberStack)

        expect(second.status).toBe("alreadyHeld")
        expect(harness.http.gets).toEqual([memberStack.issuersUrl, memberStack.revocationsUrl])
        expect(harness.http.posts).toHaveLength(postsAfterFirst)
    })

    it("answers alreadyHeld without touching a key", async () => {
        const { harness, memberStack } = await onboardedHarness()
        await issue(harness, memberStack)
        harness.deviceKey.calls.length = 0

        expect((await issue(harness, memberStack)).status).toBe("alreadyHeld")
        expect(harness.deviceKey.calls).toEqual([])
    })

    it("unlocks the agreement key once and signs once, after the challenge", async () => {
        const { harness, memberStack } = await onboardedHarness()

        await issue(harness, memberStack)

        expect(harness.deviceKey.calls.filter((call) => call !== "getPublicKeyJwk")).toEqual(["ecdh", "sign"])
        expect(harness.deviceKey.prompts).toEqual([
            { title: "Unlock your credentials", subtitle: "Needed once each time the app starts" },
            {
                title: "Bind a credential to this phone",
                subtitle: `${APPROVAL_SCOPE.programme} (${APPROVAL_SCOPE.country})`
            }
        ])
    })

    it("never uses a key before the challenge answers", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.http.onPost(memberStack.challengeUrl, () => ({ status: 503, body: {} }))
        harness.deviceKey.calls.length = 0

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
        expect(harness.deviceKey.calls).toEqual([])
    })

    it("maps a cancel at the binding signature to CONSENT_DENIED, and posts nothing to sign", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.deviceKey.failWith("sign", "USER_CANCELED")

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "CONSENT_DENIED" })
        expect(harness.http.posts.some(({ url }) => url === memberStack.credentialsUrl)).toBe(false)
    })

    it("posts the identity public key derived from this device key's ECDH, as decimal strings", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const expected = deriveEddsaKeypair(sharedSecretFor(harness.devicePrivateKey, eddsaPeerPointBytes()))

        await issue(harness, memberStack)

        const posted = harness.http.posts.find(({ url }) => url === memberStack.credentialsUrl)?.body as {
            identityPublicKey: [string, string]
        }
        expect(posted.identityPublicKey).toEqual([String(expected.publicKey[0]), String(expected.publicKey[1])])
    })

    it("stores no credential and no issuer entry when the binding signature is cancelled", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.deviceKey.failWith("sign", "USER_CANCELED")

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "CONSENT_DENIED" })

        expect(await harness.service.listCredentials()).toEqual([])
        expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toBeNull()
        expect(memberStack.issued.size).toBe(0)
    })

    it("stores nothing when the key is invalidated at the binding signature", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.deviceKey.failWith("sign", "KEY_INVALIDATED")

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "INTERNAL" })

        expect(harness.http.posts.some(({ url }) => url === memberStack.credentialsUrl)).toBe(false)
        expect(await harness.service.listCredentials()).toEqual([])
        expect(await readIssuerEntry(harness.store, memberStack.issuerNetworkId, APPROVAL_SCOPE)).toBeNull()
    })

    it("after a cancelled unlock, the next issue prompts again and succeeds, and a third op does not", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const ecdhCalls = () => harness.deviceKey.calls.filter((call) => call === "ecdh").length
        harness.deviceKey.failWith("ecdh", "USER_CANCELED")

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "CONSENT_DENIED" })
        expect(ecdhCalls()).toBe(1)

        expect((await issue(harness, memberStack)).status).toBe("stored")
        expect(ecdhCalls()).toBe(2)

        const other = { ...issueParams(memberStack), approvalScope: { programme: "alt-programme", country: "ZZZ" } }
        const third = await harness.service.handlers["credential.issue"]!(other, { caller: CALLER })
        expect(third.status).toBe("stored")
        expect(ecdhCalls()).toBe(2)
    })

    it("maps a cancel at the seed unlock to CONSENT_DENIED", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.deviceKey.failWith("ecdh", "USER_CANCELED")

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "CONSENT_DENIED" })
    })

    it("maps an invalidated key to INTERNAL", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.deviceKey.failWith("sign", "KEY_INVALIDATED")

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "INTERNAL" })
    })

    it("maps a failed authentication at the binding signature to INTERNAL, and posts nothing to sign", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.deviceKey.failWith("sign", "AUTHENTICATION_FAILED")

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "INTERNAL" })
        expect(harness.http.posts.some(({ url }) => url === memberStack.credentialsUrl)).toBe(false)
    })

    it("lets a signer failure that is not a DeviceKeyError through unchanged", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const failure = new Error("keystore unavailable")
        harness.deviceKey.signerFor = () => ({
            getPublicKeyJwk: () => harness.deviceKey.getPublicKeyJwk(),
            sign: async () => {
                throw failure
            },
            signDigest: async () => {
                throw failure
            }
        })

        await expect(issue(harness, memberStack)).rejects.toBe(failure)
    })

    it("reports INVALID_REQUEST when the chain retires the issuer's own key from the approved set", async () => {
        const { harness, memberStack } = await onboardedHarness()
        // The credential is still issued and signed by credentialSigner, but the set, served and on
        // chain alike (chainRoots follows the edit), never names that key. addCredential rejects
        // this with a plain Error, not a WalletError, so it lands on CREDENTIAL_INVALID rather than
        // the ISSUER_NOT_APPROVED code buildPresentation's own check reports.
        memberStack.approvedIssuerKeys[0] = await new LocalCredentialSigner("someone-else").getPublicKey()

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "INVALID_REQUEST" })
        expect(await harness.service.listCredentials()).toEqual([])
    })

    it("reports ISSUER_UNREACHABLE, with no challenge and nothing stored, when only the served set drops the issuer's key", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const roots = memberStack.chainRoots()
        memberStack.approvedIssuerKeys[0] = await new LocalCredentialSigner("someone-else").getPublicKey()
        harness.roots.read = async () => roots

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
        expect(challenges(harness, memberStack)).toHaveLength(0)
        expect(await harness.service.listCredentials()).toEqual([])
    })

    it("holds one credential per issuer, each indexed with its own issuer URL", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const otherStack = await createMemberStack(harness.http, { now: () => harness.now.value })

        await issue(harness, memberStack)
        harness.roots.read = async () => otherStack.chainRoots()
        await issue(harness, otherStack)

        const held = await harness.service.listCredentials()
        expect(held.map((credential) => credential.issuerNetworkId).sort()).toEqual(
            [memberStack.issuerNetworkId, otherStack.issuerNetworkId].sort()
        )
        expect(await readIssuerEntry(harness.store, otherStack.issuerNetworkId, APPROVAL_SCOPE)).toMatchObject({
            issuersUrl: otherStack.issuersUrl,
            programme: APPROVAL_SCOPE.programme,
            country: APPROVAL_SCOPE.country
        })
    })

    it("relays the issuer's own refusal instead of throwing", async () => {
        const { harness, memberStack } = await onboardedHarness()
        memberStack.refusal = { status: 400, body: { error: "subject is not approved", code: "NOT_APPROVED" } }

        await expect(issue(harness, memberStack)).resolves.toEqual({
            status: "refused",
            code: "NOT_APPROVED",
            message: "subject is not approved"
        })
        expect(await harness.service.listCredentials()).toEqual([])
    })

    it("relays the issuer's DEVICE_ATTESTATION_REJECTED refusal with its code and message", async () => {
        const { harness, memberStack } = await onboardedHarness()
        const error = "device key attestation rejected"
        memberStack.refusal = { status: 400, body: { error, code: "DEVICE_ATTESTATION_REJECTED" } }

        await expect(issue(harness, memberStack)).resolves.toEqual({
            status: "refused",
            code: "DEVICE_ATTESTATION_REJECTED",
            message: error
        })
        expect(await harness.service.listCredentials()).toEqual([])
    })

    it("names an unexplained refusal rather than inventing the issuer's vocabulary", async () => {
        const { harness, memberStack } = await onboardedHarness()
        memberStack.refusal = { status: 500, body: { error: "issuance failed" } }

        await expect(issue(harness, memberStack)).resolves.toEqual({
            status: "refused",
            code: "ISSUANCE_REFUSED",
            message: "issuance failed"
        })
    })

    it("reports an unreachable issuer as ISSUER_UNREACHABLE, not as a refusal", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.http.onPost(memberStack.credentialsUrl, () => {
            throw new Error("ECONNREFUSED")
        })

        await expect(issue(harness, memberStack)).rejects.toMatchObject({
            code: "ISSUER_UNREACHABLE",
            message: "ECONNREFUSED"
        })
    })

    it("reports an unusable issuer response as ISSUER_UNREACHABLE", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.http.onPost(memberStack.credentialsUrl, () => ({ status: 201, body: { unexpected: true } }))

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
    })

    it("reports unreadable authority lists as ISSUER_UNREACHABLE, since no verifier is involved", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.http.onGet(memberStack.issuersUrl, () => ({ status: 503, body: {} }))

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
        expect(await harness.service.listCredentials()).toEqual([])
    })

    it("names unreadable authority lists when the read throws a non-Error", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.http.onGet(memberStack.issuersUrl, () => {
            throw "connection reset"
        })

        await expect(issue(harness, memberStack)).rejects.toMatchObject({
            code: "ISSUER_UNREACHABLE",
            message: "the issuer's approved-issuer set or revocation snapshot is unreadable"
        })
    })

    it("reports a malformed credential as ISSUER_UNREACHABLE without ever constructing a Wallet", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.http.onPost(memberStack.credentialsUrl, () => ({
            status: 201,
            body: { id: "cred-1", credential: { not: "a credential" } }
        }))

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "ISSUER_UNREACHABLE" })
    })

    it("reports a non-Error thrown while parsing the credential", async () => {
        const { harness, memberStack } = await onboardedHarness()
        // Passes the top-level `exactKeys` check (which reads via `Object.keys`, untrapped here),
        // then throws a non-Error value only once `parseZkCredential` accesses `.body`.
        const throwsOnAccess = new Proxy(
            { body: {}, issuerPublicKey: [], signature: {} },
            {
                get(target, prop) {
                    if (prop === "body") throw "not an Error instance"
                    return Reflect.get(target, prop)
                }
            }
        )
        harness.http.onPost(memberStack.credentialsUrl, () => ({
            status: 201,
            body: { id: "cred-1", credential: throwsOnAccess }
        }))

        await expect(issue(harness, memberStack)).rejects.toMatchObject({
            code: "ISSUER_UNREACHABLE",
            message: "malformed credential"
        })
    })

    it("stores nothing when the challenge cannot be had", async () => {
        const { harness, memberStack } = await onboardedHarness()
        harness.http.onPost(memberStack.challengeUrl, () => ({ status: 400, body: { error: "unknown subject" } }))

        await expect(issue(harness, memberStack)).resolves.toMatchObject({ status: "refused" })
        expect(harness.http.posts.some(({ url }) => url === memberStack.credentialsUrl)).toBe(false)
    })

    it("requires onboarding", async () => {
        const harness = createServiceHarness()
        const memberStack = await createMemberStack(harness.http, { now: () => harness.now.value })

        await expect(issue(harness, memberStack)).rejects.toMatchObject({ code: "NOT_ONBOARDED" })
    })
})

describe("listing what is held", () => {
    const anHourInMs = 60 * 60 * 1000

    it("reports the validity window, which the clock moves through", async () => {
        const { harness, memberStack } = await onboardedHarness()
        await issue(harness, memberStack)

        harness.now.value += 2 * anHourInMs
        expect((await harness.service.listCredentials())[0].status).toBe("expired")

        harness.now.value -= 4 * anHourInMs
        expect((await harness.service.listCredentials())[0].status).toBe("not-yet-valid")
    })

    // The whole network revokes into one registry, so a listing of credentials from any number of
    // issuers has a single authority to ask - and asking it names no issuer. Before that, this
    // screen could only report the dates.
    it("reports a credential the network has revoked, whoever issued it", async () => {
        const { harness, memberStack } = await onboardedHarness()
        await issue(harness, memberStack)
        expect((await harness.service.listCredentials())[0].status).toBe("valid")

        harness.revocationAnswer.value = true

        expect((await harness.service.listCredentials())[0].status).toBe("revoked")
    })

    it("does not call a credential valid when there is no authority to ask", async () => {
        const { harness, memberStack } = await onboardedHarness({ revocations: null })
        await issue(harness, memberStack)

        expect((await harness.service.listCredentials())[0].status).toBe("unchecked")
    })

    it("reports unchecked, rather than failing the listing, when the authority cannot be reached", async () => {
        const { harness, memberStack } = await onboardedHarness({
            revocations: {
                isRevoked: async () => {
                    throw new Error("connection refused")
                }
            }
        })
        await issue(harness, memberStack)

        expect((await harness.service.listCredentials())[0].status).toBe("unchecked")
    })

    // A credential outside its dates is finished whatever the registry says, and the read would
    // tell whoever serves the RPC which commitment this device holds for no reason.
    it("does not ask the registry about a credential already outside its window", async () => {
        let reads = 0
        const { harness, memberStack } = await onboardedHarness({
            revocations: {
                isRevoked: async () => {
                    reads += 1
                    return false
                }
            }
        })
        await issue(harness, memberStack)
        harness.now.value += 2 * anHourInMs

        expect((await harness.service.listCredentials())[0].status).toBe("expired")
        expect(reads).toBe(0)
    })

    // Held records gained issuer fields this round with no migration; the demo erases and
    // reinstalls, and anything left from before is unnameable rather than half-rendered.
    it("leaves out a credential that predates the issuer index", async () => {
        const { harness, memberStack } = await onboardedHarness()
        await issue(harness, memberStack)
        for (const key of await harness.store.list()) {
            if (key.startsWith("user-app-core:issuer-index:")) await harness.store.delete(key)
        }

        expect(await harness.service.listCredentials()).toEqual([])
    })
})
