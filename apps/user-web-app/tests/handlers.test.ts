import { MemoryStore, Wallet, REVOCATION_SECRET_PREFIX, type ChainStateLoader } from "@coordination-network/wallet"
import {
    countryCode,
    programmeHash,
    LocalCredentialSigner,
    issueZkCredential,
    serializeZkCredential,
    type SerializedZkCredential
} from "@coordination-network/credential"
import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import { credentialsBody } from "../../issuer-service/src/schemas"
import { loadOrCreateIdentity } from "../src/identity"
import { memberChainStateLoader } from "../src/chain-state"
import { createUserHandlers } from "../src/handlers"
import { createRequestHandler, decodeResponse, encodeRequest } from "@coordination-network/user-app-link"
import { credentialIssueParams, presentationCreateParams } from "../../../packages/user-app-link/tests/fixtures"

const issuer = credentialIssueParams.issuerNetworkId
const scope = credentialIssueParams.approvalScope
const caller = { name: "Member", scheme: "memberapp" }
const issuerSet = ApprovedIssuerSet.fromLeaves([1n])
const revocations = new RevocationRegistry()
const originalFetch = global.fetch

describe("current browser link handlers", () => {
    let store: MemoryStore
    let wallet: { addCredential: jest.Mock; syncCredential: jest.Mock; getCredential: jest.Mock; present: jest.Mock }
    let fetcher: jest.Mock
    let issuedScope: string
    let refuse: boolean

    beforeEach(() => {
        store = new MemoryStore()
        issuedScope = scope.programme
        refuse = false
        wallet = {
            addCredential: jest.fn().mockResolvedValue("credential-1"),
            syncCredential: jest.fn().mockResolvedValue(undefined),
            getCredential: jest.fn().mockResolvedValue({ status: "valid" }),
            present: jest.fn().mockResolvedValue({ proof: Uint8Array.of(1, 2), publicInputs: ["3"] })
        }
        fetcher = jest.fn(async (url: string, init?: RequestInit) => {
            if (url.endsWith("/challenge"))
                return new Response(JSON.stringify({ challengeId: "challenge", nonce: "33".repeat(32) }))
            if (url.endsWith("/credentials")) {
                if (refuse)
                    return new Response(JSON.stringify({ code: "SUBJECT_NOT_ELIGIBLE", error: "issuance refused" }), {
                        status: 403
                    })
                const binding = JSON.parse(String(init!.body))
                const credential: SerializedZkCredential = {
                    body: {
                        programmeHash: programmeHash(issuedScope).toString(),
                        countryCode: countryCode(scope.country),
                        notBefore: 1,
                        expiresAt: 2,
                        deviceKeyCommitment: "2",
                        holderKeyCommitment: "3",
                        revocationCommitment: binding.revocation.commitment
                    },
                    issuerPublicKey: ["4", "5"],
                    signature: { R8: ["6", "7"], S: "8" }
                }
                return new Response(JSON.stringify({ id: "credential-1", credential }))
            }
            if (url.endsWith("/issuers"))
                return new Response(
                    JSON.stringify({ leaves: issuerSet.leafSlots.map(String), root: issuerSet.root.toString() })
                )
            if (url.endsWith("/snapshot"))
                return new Response(
                    JSON.stringify({ root: revocations.root.toString(), snapshot: revocations.export() })
                )
            return new Response(JSON.stringify({ verificationId: "verification-1", ok: false }))
        })
        global.fetch = fetcher
    })
    afterEach(() => {
        global.fetch = originalFetch
    })
    async function handlers() {
        const options = {
            identity: await loadOrCreateIdentity(store),
            store,
            serverUrlFor: (issuerId: string) =>
                issuerId.toLowerCase() === issuer ? new URL(credentialIssueParams.challengeUrl).origin : undefined,
            walletFor: () => wallet as unknown as Wallet
        }
        return createUserHandlers(options)
    }

    it("serves only the current three operations and returns a schema-valid signed registration", async () => {
        const operations = await handlers()
        expect(Object.keys(operations).sort()).toEqual(["credential.issue", "presentation.create", "registration.sign"])
        const handler = createRequestHandler({ handlers: operations, consent: async () => true })
        const url = encodeRequest({
            id: "registration",
            version: "v1",
            caller,
            callback: "memberapp://v1/response",
            op: "registration.sign",
            params: { chainId: 31337, verifyingContract: `0x${"22".repeat(20)}` }
        })
        const response = decodeResponse(await handler.handle(url))
        expect(response.ok).toBe(true)
        if (!response.ok) throw new Error("registration refused")
        expect(response.result).toMatchObject({ securityLevel: "SOFTWARE", request: { chainId: 31337 } })
    })

    it("performs issuance inside the wallet and retains the revocation secret locally", async () => {
        const result = await (await handlers())["credential.issue"]!(credentialIssueParams, { caller })
        expect(result).toEqual({ status: "stored", credentialId: "credential-1" })
        expect(wallet.addCredential.mock.calls[0][0].revocationSecret).toHaveLength(32)
        expect(JSON.stringify(result)).not.toContain("revocation")
        const issuance = fetcher.mock.calls.find(([url]) => String(url).endsWith("/credentials"))!
        expect(JSON.parse(issuance[1].body)).toMatchObject({
            subjectNetworkId: (await loadOrCreateIdentity(store)).keys.networkId,
            approvalScope: scope
        })
    })

    it.each([false, true])(
        "stores a real signed credential even if tree reads fail after issuance: %s",
        async (offlineAfterIssue) => {
            const identity = await loadOrCreateIdentity(store)
            const signer = new LocalCredentialSigner("browser-relay-test")
            const approvedIssuers = new ApprovedIssuerSet([await signer.getPublicKey()])
            const serverUrl = new URL(credentialIssueParams.challengeUrl).origin
            const walletOptions = {
                identitySeed: identity.identitySeed,
                deviceSigner: identity.deviceSigner,
                store,
                consent: async () => true,
                proofGenerator: {
                    generateProof: async () => {
                        throw new Error("not needed for issuance")
                    }
                },
                loadChainState: memberChainStateLoader(serverUrl)
            }
            const realWallet = new Wallet(walletOptions)
            let issued = false
            global.fetch = jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
                if (String(url).endsWith("/issuers") || String(url).endsWith("/snapshot")) {
                    if (issued && offlineAfterIssue) throw new Error("trees unavailable after issuance")
                    return new Response(
                        JSON.stringify(
                            String(url).endsWith("/issuers")
                                ? {
                                      leaves: approvedIssuers.leafSlots.map(String),
                                      root: approvedIssuers.root.toString()
                                  }
                                : { root: revocations.root.toString(), snapshot: revocations.export() }
                        )
                    )
                }
                if (String(url).endsWith("/challenge"))
                    return new Response(
                        JSON.stringify({
                            challengeId: "123e4567-e89b-42d3-a456-426614174000",
                            nonce: "33".repeat(32)
                        })
                    )
                const body = credentialsBody.parse(JSON.parse(String(init!.body)))
                const now = Math.floor(Date.now() / 1000)
                const credential = await issueZkCredential(
                    {
                        ...body,
                        issuerNetworkId: issuer,
                        nonce: new Uint8Array(32).fill(0x33),
                        validFrom: now - 1,
                        validUntil: now + 3600
                    },
                    signer,
                    { isApprovedNetworkMember: async () => true }
                )
                issued = true
                return new Response(
                    JSON.stringify({ id: "real-credential", credential: serializeZkCredential(credential) })
                )
            })
            const options = {
                identity,
                store,
                serverUrlFor: () => serverUrl,
                walletFor: (issuerId: string, loadChainState: ChainStateLoader = walletOptions.loadChainState) => {
                    if (issuerId !== issuer) throw new Error("unknown issuer")
                    return new Wallet({ ...walletOptions, loadChainState })
                }
            }
            const operations = createUserHandlers(options)
            expect(await operations["credential.issue"]!(credentialIssueParams, { caller })).toEqual({
                status: "stored",
                credentialId: "real-credential"
            })
            expect((await realWallet.getCredential("real-credential"))?.status).toBe("valid")
            expect(await store.get(`${REVOCATION_SECRET_PREFIX}real-credential`)).not.toBeNull()
        }
    )

    it("refuses an issuer changing the scope that was consented to", async () => {
        issuedScope = "different"
        await expect((await handlers())["credential.issue"]!(credentialIssueParams, { caller })).rejects.toThrow(
            /scope/
        )
        expect(wallet.addCredential).not.toHaveBeenCalled()
    })

    it("passes issuer refusal through without saving a credential", async () => {
        refuse = true
        expect(await (await handlers())["credential.issue"]!(credentialIssueParams, { caller })).toMatchObject({
            status: "refused",
            code: "SUBJECT_NOT_ELIGIBLE"
        })
        expect(wallet.addCredential).not.toHaveBeenCalled()
    })

    it("rejects an issuer's endpoints on another origin before any network request", async () => {
        const params = {
            ...credentialIssueParams,
            challengeUrl: "http://other-member.test/v1/challenge",
            credentialsUrl: "http://other-member.test/v1/credentials",
            issuersUrl: "http://other-member.test/v1/issuers",
            revocationsUrl: "http://other-member.test/v1/revocations/snapshot"
        }
        await expect((await handlers())["credential.issue"]!(params, { caller })).rejects.toThrow(/issuer|origin/i)
        expect(fetcher).not.toHaveBeenCalled()
    })

    it("rejects an unknown issuer before requesting a challenge", async () => {
        await expect(
            (await handlers())["credential.issue"]!(
                { ...credentialIssueParams, issuerNetworkId: `0x${"bb".repeat(32)}` },
                { caller }
            )
        ).rejects.toThrow("unknown issuer")
        expect(fetcher).not.toHaveBeenCalled()
        expect(wallet.addCredential).not.toHaveBeenCalled()
    })

    it.each(["challengeUrl", "credentialsUrl", "issuersUrl", "revocationsUrl"] as const)(
        "checks %s against the configured issuer",
        async (endpoint) => {
            await expect(
                (await handlers())["credential.issue"]!(
                    { ...credentialIssueParams, [endpoint]: "http://other-member.test/v1/credentials" },
                    { caller }
                )
            ).rejects.toThrow(/origin/)
            expect(fetcher).not.toHaveBeenCalled()
        }
    )

    it("resolves the wallet before starting a challenge or issuing a credential", async () => {
        const options = {
            identity: await loadOrCreateIdentity(store),
            store,
            serverUrlFor: () => new URL(credentialIssueParams.challengeUrl).origin,
            walletFor: () => {
                throw new Error("wallet unavailable")
            }
        }
        await expect(
            createUserHandlers(options)["credential.issue"]!(credentialIssueParams, { caller })
        ).rejects.toThrow("wallet unavailable")
        expect(fetcher).not.toHaveBeenCalled()
    })

    it("does not issue when the public tree state is unavailable", async () => {
        const normalFetch = fetcher.getMockImplementation()!
        fetcher.mockImplementation((url: string, init?: RequestInit) =>
            url.endsWith("/issuers") ? Promise.reject(new Error("tree unavailable")) : normalFetch(url, init)
        )
        await expect((await handlers())["credential.issue"]!(credentialIssueParams, { caller })).rejects.toThrow(
            "tree unavailable"
        )
        expect(fetcher.mock.calls.some(([url]) => /\/(challenge|credentials)$/.test(String(url)))).toBe(false)
        expect(wallet.addCredential).not.toHaveBeenCalled()
    })

    it.each(["/issuers", "/snapshot"])("does not issue when %s does not match its root", async (endpoint) => {
        const normalFetch = fetcher.getMockImplementation()!
        fetcher.mockImplementation(async (url: string, init?: RequestInit) => {
            const response = await normalFetch(url, init)
            if (!url.endsWith(endpoint)) return response
            const body = await response.json()
            return new Response(JSON.stringify({ ...body, root: (BigInt(body.root) + 1n).toString() }))
        })
        await expect((await handlers())["credential.issue"]!(credentialIssueParams, { caller })).rejects.toThrow(
            /roots/
        )
        expect(fetcher.mock.calls.some(([url]) => /\/(challenge|credentials)$/.test(String(url)))).toBe(false)
        expect(wallet.addCredential).not.toHaveBeenCalled()
    })

    async function hold() {
        await store.set(`app:credential:${issuer}`, "credential-1")
        await store.set(`app:credential-meta:${issuer}`, JSON.stringify({ id: "credential-1", ...scope }))
    }
    it("presents a matching credential across members and returns only its record id", async () => {
        await hold()
        const result = await (
            await handlers()
        )["presentation.create"]!({ ...presentationCreateParams, ...scope }, { caller })
        expect(result).toEqual({ verificationId: "verification-1" })
        expect(wallet.syncCredential).toHaveBeenCalled()
        expect(wallet.present.mock.calls[0][0]).toBe("credential-1")
        expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({
            proof: "0x0102",
            requestId: presentationCreateParams.requestId
        })
    })
    it("does not prove a mismatched programme or a revoked credential", async () => {
        await hold()
        const operations = await handlers()
        await expect(
            operations["presentation.create"]!({ ...presentationCreateParams, programme: "other" }, { caller })
        ).rejects.toThrow(/scope/)
        wallet.getCredential.mockResolvedValue({ status: "revoked" })
        await expect(
            operations["presentation.create"]!({ ...presentationCreateParams, ...scope }, { caller })
        ).rejects.toThrow(/scope/)
        expect(wallet.present).not.toHaveBeenCalled()
    })
})
