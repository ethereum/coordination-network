import { sha256 } from "@noble/hashes/sha2"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import { deriveKeys } from "@coordination-network/identity"
import {
    LocalCredentialSigner,
    LocalP256Signer,
    parseZkCredential,
    type DeviceSigner,
    type ZkPresentationInputs,
    type ZkPresentationProof
} from "@coordination-network/credential"
import { ApprovedIssuerSet } from "@coordination-network/issuer-set"
import { RevocationRegistry } from "@coordination-network/revocation-registry"
import {
    CREDENTIAL_PREFIX,
    MemoryStore,
    REVOCATION_SECRET_PREFIX,
    Wallet,
    WalletError,
    type ChainStateLoader,
    type ConsentRequest,
    type WalletChainState
} from "@coordination-network/wallet"
import { CREDENTIAL_ID, issueForTest, REVOCATION_SECRET_2, VALID_AT, type Fixture } from "./fixtures"

const SECRET = `0x${"11".repeat(32)}` as const

function recordingConsent(answer: boolean, order?: string[]) {
    const seen: ConsentRequest[] = []
    return {
        seen,
        prompt: async (request: ConsentRequest) => {
            order?.push("consent")
            seen.push(request)
            return answer
        }
    }
}

class RecordingProofGenerator {
    readonly inputs: ZkPresentationInputs[] = []

    constructor(private readonly order?: string[]) {}

    async generateProof(inputs: ZkPresentationInputs): Promise<ZkPresentationProof> {
        this.order?.push("proof")
        this.inputs.push(inputs)
        return { proof: new Uint8Array(32).fill(1), publicInputs: [] }
    }
}

type HarnessOptions = {
    answer?: boolean
    store?: MemoryStore
    deviceSigner?: DeviceSigner
    identitySeed?: Uint8Array | (() => Promise<Uint8Array>)
    order?: string[]
}

async function createWallet(fixture: Fixture, options: HarnessOptions = {}) {
    const consent = recordingConsent(options.answer ?? true, options.order)
    const proofGenerator = new RecordingProofGenerator(options.order)
    const store = options.store ?? new MemoryStore()
    const harness: {
        chain: WalletChainState
        now: number
        loads: number
        loadError: Error | null
        syncErrors: unknown[]
        load: ChainStateLoader
    } = {
        chain: fixture.chain,
        now: VALID_AT * 1_000,
        loads: 0,
        loadError: null,
        syncErrors: [],
        load: async () => {
            harness.loads += 1
            if (harness.loadError) throw harness.loadError
            return harness.chain
        }
    }
    const wallet = new Wallet({
        identitySeed: options.identitySeed ?? fixture.identitySeed,
        deviceSigner: options.deviceSigner ?? fixture.deviceSigner,
        consent: consent.prompt,
        proofGenerator,
        store,
        now: () => harness.now,
        loadChainState: () => harness.load(),
        onSyncError: (error) => harness.syncErrors.push(error)
    })

    return { wallet, consent, proofGenerator, store, harness }
}

const addFixtureCredential = (wallet: Wallet, fixture: Fixture, id = CREDENTIAL_ID) =>
    wallet.addCredential({ id, credential: fixture.credential, revocationSecret: fixture.revocationSecret })

/** A second issuer's own chain state: its revocation tree, under the set both issuers sit in. */
const otherChain = (fixture: Fixture, approvedIssuers: ApprovedIssuerSet): WalletChainState => ({
    ...fixture.chain,
    approvedIssuers,
    approvedIssuerRoot: approvedIssuers.root
})

describe("key management", () => {
    let fixture: Fixture

    beforeAll(async () => {
        fixture = await issueForTest()
    })

    it("imports, lists, gets and deletes", async () => {
        const { wallet } = await createWallet(fixture)
        const networkId = await wallet.importKey(SECRET)
        expect(await wallet.listKeys()).toEqual([networkId])
        expect(await wallet.getKey(networkId)).toEqual(deriveKeys(hexToBytes(SECRET.slice(2))))
        await wallet.deleteKey(networkId)
        expect(await wallet.listKeys()).toEqual([])
        expect(await wallet.getKey(networkId)).toBeNull()
    })

    it("createFromSeed hashes high-entropy seed material", async () => {
        const { wallet } = await createWallet(fixture)
        const seed = hexToBytes("22".repeat(48))
        const networkId = await wallet.createFromSeed(seed)
        expect(await wallet.getKey(networkId)).toEqual(deriveKeys(sha256(seed)))
    })

    it("rejects empty seed material and malformed device secrets", async () => {
        const { wallet } = await createWallet(fixture)
        await expect(wallet.createFromSeed(new Uint8Array())).rejects.toThrow(/empty/)
        await expect(wallet.importKey(new Uint8Array(16))).rejects.toThrow()
    })

    it("re-importing the same secret keeps one record", async () => {
        const { wallet } = await createWallet(fixture)
        expect(await wallet.importKey(SECRET)).toBe(await wallet.importKey(SECRET))
        expect(await wallet.listKeys()).toHaveLength(1)
    })

    it("keeps keys and credentials apart in one store", async () => {
        const { wallet } = await createWallet(fixture)
        await wallet.importKey(SECRET)
        await addFixtureCredential(wallet, fixture)
        expect(await wallet.listKeys()).toHaveLength(1)
        expect(await wallet.listCredentials()).toHaveLength(1)
    })
})

describe("holding ZK credentials", () => {
    let fixture: Fixture

    beforeEach(async () => {
        fixture = await issueForTest()
    })

    it("verifies the credential and all holder bindings before storing", async () => {
        const { wallet } = await createWallet(fixture)
        expect(await addFixtureCredential(wallet, fixture)).toBe(CREDENTIAL_ID)
        const held = await wallet.getCredential(CREDENTIAL_ID)
        expect(held?.credential).toEqual(fixture.credential)
        expect(held?.status).toBe("valid")
        expect(held?.checkedAt).toBe(VALID_AT * 1_000)
    })

    // What a caller actually has is whatever the issuer's server sent. `addCredential` parses it
    // itself, so it takes it unparsed and stores what its own parse accepted.
    it("takes the issuer's response unparsed and stores the credential it verified", async () => {
        const { wallet } = await createWallet(fixture)
        const overTheWire: unknown = JSON.parse(JSON.stringify(fixture.credential))

        await wallet.addCredential({
            id: CREDENTIAL_ID,
            credential: overTheWire,
            revocationSecret: fixture.revocationSecret
        })

        expect((await wallet.getCredential(CREDENTIAL_ID))?.credential).toEqual(fixture.credential)
    })

    it("refuses a malformed or signature-tampered credential", async () => {
        const { wallet } = await createWallet(fixture)
        const changed = structuredClone(fixture.credential)
        changed.body.countryCode = 1
        await expect(
            wallet.addCredential({ id: CREDENTIAL_ID, credential: changed, revocationSecret: fixture.revocationSecret })
        ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" })
        expect(await wallet.listCredentials()).toEqual([])
    })

    it("refuses to overwrite an already-stored credential", async () => {
        const { wallet, store } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)
        const storedCredential = await store.get(`${CREDENTIAL_PREFIX}${CREDENTIAL_ID}`)
        const storedSecret = await store.get(`${REVOCATION_SECRET_PREFIX}${CREDENTIAL_ID}`)

        await expect(addFixtureCredential(wallet, fixture)).rejects.toMatchObject({ code: "ALREADY_STORED" })

        expect(await store.get(`${CREDENTIAL_PREFIX}${CREDENTIAL_ID}`)).toBe(storedCredential)
        expect(await store.get(`${REVOCATION_SECRET_PREFIX}${CREDENTIAL_ID}`)).toBe(storedSecret)
    })

    it("refuses an issuer outside the approved set", async () => {
        const { wallet, harness } = await createWallet(fixture)
        const stranger = new LocalCredentialSigner("stranger")
        harness.chain = {
            ...harness.chain,
            approvedIssuers: new ApprovedIssuerSet([await stranger.getPublicKey()])
        }
        harness.chain.approvedIssuerRoot = harness.chain.approvedIssuers.root
        await expect(addFixtureCredential(wallet, fixture)).rejects.toThrow(/approved set/)
    })

    it("refuses the wrong identity seed, revocation secret, or device signer", async () => {
        const wrongIdentity = await createWallet(fixture, { identitySeed: hexToBytes("31".repeat(32)) })
        await expect(addFixtureCredential(wrongIdentity.wallet, fixture)).rejects.toThrow(/holder commitment/)

        const normal = await createWallet(fixture)
        await expect(
            normal.wallet.addCredential({
                id: CREDENTIAL_ID,
                credential: fixture.credential,
                revocationSecret: hexToBytes("32".repeat(32))
            })
        ).rejects.toThrow(/revocation commitment/)

        const wrongDevice = await createWallet(fixture, { deviceSigner: LocalP256Signer.generate() })
        await expect(addFixtureCredential(wrongDevice.wallet, fixture)).rejects.toThrow(/device commitment/)
    })

    it("refuses a credential already present in the revocation tree", async () => {
        const { body } = parseZkCredential(fixture.credential)
        fixture.chain.revocations.revoke(body.revocationCommitment)
        fixture.chain.revocationRoot = fixture.chain.revocations.root
        const { wallet } = await createWallet(fixture)
        await expect(addFixtureCredential(wallet, fixture)).rejects.toMatchObject({ code: "REVOKED" })
    })

    it("refuses an empty id or malformed revocation secret", async () => {
        const { wallet } = await createWallet(fixture)
        await expect(
            wallet.addCredential({ id: "", credential: fixture.credential, revocationSecret: fixture.revocationSecret })
        ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" })
        await expect(
            wallet.addCredential({
                id: CREDENTIAL_ID,
                credential: fixture.credential,
                revocationSecret: new Uint8Array(2)
            })
        ).rejects.toMatchObject({ code: "CREDENTIAL_INVALID" })
    })

    it("blocks credentials imported outside their validity window", async () => {
        const early = await createWallet(fixture)
        early.harness.now = (VALID_AT - 4_000) * 1_000
        await expect(addFixtureCredential(early.wallet, fixture)).rejects.toMatchObject({ code: "NOT_YET_VALID" })

        const late = await createWallet(fixture)
        late.harness.now = (VALID_AT + 4_000) * 1_000
        await expect(addFixtureCredential(late.wallet, fixture)).rejects.toMatchObject({ code: "EXPIRED" })
    })

    it("deletes a held credential", async () => {
        const { wallet } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)
        await wallet.deleteCredential(CREDENTIAL_ID)
        expect(await wallet.getCredential(CREDENTIAL_ID)).toBeNull()
        expect(await wallet.listCredentials()).toEqual([])
    })

    it("refuses trees that are not pinned to their authoritative roots", async () => {
        const { wallet, harness } = await createWallet(fixture)
        harness.chain.approvedIssuerRoot += 1n
        await expect(addFixtureCredential(wallet, fixture)).rejects.toMatchObject({ code: "CHAIN_STATE_INVALID" })

        harness.chain.approvedIssuerRoot = harness.chain.approvedIssuers.root
        harness.chain.revocationRoot += 1n
        await expect(addFixtureCredential(wallet, fixture)).rejects.toMatchObject({ code: "CHAIN_STATE_INVALID" })
        expect(await wallet.listCredentials()).toEqual([])
    })

    it("reports chain state loading failures without marking the credential invalid", async () => {
        const { wallet, harness } = await createWallet(fixture)
        harness.loadError = new Error("fetch failed")

        await expect(addFixtureCredential(wallet, fixture)).rejects.toMatchObject({
            code: "CHAIN_STATE_UNAVAILABLE",
            message: "fetch failed"
        })
        expect(await wallet.listCredentials()).toEqual([])
    })
})

describe("consent-gated ZK presentation", () => {
    let fixture: Fixture

    beforeEach(async () => {
        fixture = await issueForTest()
    })

    it("builds private inputs and delegates proof generation", async () => {
        const { wallet, consent, proofGenerator, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)
        const proof = await wallet.present(CREDENTIAL_ID, fixture.request, harness.load)
        expect(proof.proof).toHaveLength(32)
        expect(proofGenerator.inputs).toHaveLength(1)
        expect(proofGenerator.inputs[0]).toMatchObject({
            current_time: String(fixture.request.currentTime),
            required_programme_hash: expect.any(String),
            required_country_code: expect.any(String)
        })
        expect(consent.seen).toEqual([
            {
                kind: "present",
                credentialId: CREDENTIAL_ID,
                audience: fixture.request.audience,
                programme: fixture.request.programme,
                country: fixture.request.country
            }
        ])
    })

    it("rejects verifier-chosen times outside the holder clock window before consent or proving", async () => {
        const { wallet, consent, proofGenerator, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)

        for (const currentTime of [VALID_AT - 301, VALID_AT + 301, 0]) {
            await expect(
                wallet.present(CREDENTIAL_ID, { ...fixture.request, currentTime }, harness.load)
            ).rejects.toMatchObject({
                code: "PRESENTATION_FAILED",
                message: "presentation request time is not current"
            })
        }
        expect(consent.seen).toEqual([])
        expect(proofGenerator.inputs).toEqual([])

        await wallet.present(CREDENTIAL_ID, { ...fixture.request, currentTime: VALID_AT + 300 }, harness.load)
        expect(proofGenerator.inputs).toHaveLength(1)
    })

    it("signs and proves only after consent", async () => {
        const order: string[] = []
        const deviceSigner: DeviceSigner = {
            getPublicKeyJwk: () => fixture.deviceSigner.getPublicKeyJwk(),
            sign: async (message) => {
                order.push("sign")
                return fixture.deviceSigner.sign(message)
            },
            signDigest: async (digest) => {
                order.push("sign")
                return fixture.deviceSigner.signDigest(digest)
            }
        }
        const { wallet, harness } = await createWallet(fixture, { deviceSigner, order })
        await addFixtureCredential(wallet, fixture)
        await wallet.present(CREDENTIAL_ID, fixture.request, harness.load)
        expect(order).toEqual(["consent", "sign", "proof"])
    })

    it("touches neither signer nor prover when the user declines", async () => {
        const order: string[] = []
        const deviceSigner: DeviceSigner = {
            getPublicKeyJwk: () => fixture.deviceSigner.getPublicKeyJwk(),
            sign: async (message) => {
                order.push("sign")
                return fixture.deviceSigner.sign(message)
            },
            signDigest: async (digest) => {
                order.push("sign")
                return fixture.deviceSigner.signDigest(digest)
            }
        }
        const { wallet, proofGenerator, harness } = await createWallet(fixture, { answer: false, deviceSigner, order })
        await addFixtureCredential(wallet, fixture)
        await expect(wallet.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "CONSENT_DENIED"
        })
        expect(order).toEqual(["consent"])
        expect(proofGenerator.inputs).toEqual([])
    })

    it("proves issuer membership against the whole approved set, so the root names no issuer", async () => {
        const { wallet, proofGenerator, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)
        const issuerKey = await fixture.credentialSigner.getPublicKey()
        const stranger = new LocalCredentialSigner("stranger")
        fixture.chain.approvedIssuers = new ApprovedIssuerSet([await stranger.getPublicKey(), issuerKey])
        fixture.chain.approvedIssuerRoot = fixture.chain.approvedIssuers.root
        await wallet.syncRevocations()

        await wallet.present(CREDENTIAL_ID, fixture.request, harness.load)

        const [inputs] = proofGenerator.inputs
        // A set of two folds one sibling, so the emitted root is the set's, which every member of
        // the set shares. A depth of 0 would emit the issuer's own leaf and name it.
        expect(inputs.issuer_depth).not.toBe("0")
        expect([BigInt(inputs.issuer_pub_x), BigInt(inputs.issuer_pub_y)]).toEqual(issuerKey)
        expect(fixture.chain.approvedIssuerRoot).not.toBe(ApprovedIssuerSet.leafOf(issuerKey))
    })

    it("labels proveOwnership separately while using the same credential-bound proof", async () => {
        const { wallet, consent, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)
        await expect(wallet.proveOwnership(CREDENTIAL_ID, fixture.request, harness.load)).resolves.toBeDefined()
        expect(consent.seen[0].kind).toBe("prove-ownership")
    })

    it("reports presentation input failures with a stable wallet error", async () => {
        const deviceSigner: DeviceSigner = {
            getPublicKeyJwk: () => fixture.deviceSigner.getPublicKeyJwk(),
            sign: async () => {
                throw new Error("signing failed")
            },
            signDigest: async () => {
                throw new Error("signing failed")
            }
        }
        const { wallet, harness } = await createWallet(fixture, { deviceSigner })
        await addFixtureCredential(wallet, fixture)

        await expect(wallet.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "PRESENTATION_FAILED",
            message: "signing failed"
        })
    })

    it("fails before prompting when the credential is missing", async () => {
        const { wallet, consent, harness } = await createWallet(fixture)
        await expect(wallet.present("missing", fixture.request, harness.load)).rejects.toMatchObject({
            code: "NOT_FOUND"
        })
        expect(consent.seen).toEqual([])
    })
})

describe("public state synchronization", () => {
    let fixture: Fixture

    beforeEach(async () => {
        fixture = await issueForTest()
    })

    it("blocks a revoked credential after one tree refresh", async () => {
        const { wallet, consent, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)
        const { body } = parseZkCredential(fixture.credential)
        fixture.chain.revocations.revoke(body.revocationCommitment)
        fixture.chain.revocationRoot = fixture.chain.revocations.root
        await wallet.syncRevocations()
        expect((await wallet.getCredential(CREDENTIAL_ID))?.status).toBe("revoked")
        await expect(wallet.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "REVOKED"
        })
        expect(consent.seen).toEqual([])
    })

    it("blocks a credential when its issuer is retired", async () => {
        const { wallet, consent, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)
        fixture.chain.approvedIssuers.retire(await fixture.credentialSigner.getPublicKey())
        fixture.chain.approvedIssuerRoot = fixture.chain.approvedIssuers.root
        await wallet.syncRevocations()
        expect((await wallet.getCredential(CREDENTIAL_ID))?.status).toBe("issuer-not-approved")
        await expect(wallet.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "ISSUER_NOT_APPROVED"
        })
        expect(consent.seen).toEqual([])
    })

    it("blocks expired and not-yet-valid credentials before prompting", async () => {
        const { wallet, consent, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)

        harness.now = (VALID_AT + 4_000) * 1_000
        await expect(wallet.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "EXPIRED"
        })

        harness.now = (VALID_AT - 4_000) * 1_000
        await expect(wallet.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "NOT_YET_VALID"
        })
        expect(consent.seen).toEqual([])
    })

    it("loads public state once when syncing several credentials", async () => {
        const { wallet, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture, "first")
        await addFixtureCredential(wallet, fixture, "second")
        harness.loads = 0
        await wallet.syncRevocations()
        expect(harness.loads).toBe(1)
        expect(await wallet.listCredentials()).toHaveLength(2)
    })

    it("syncCredential stamps one credential from the state its own issuer publishes", async () => {
        const { wallet, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture, "first")
        await addFixtureCredential(wallet, fixture, "second")

        const { body } = parseZkCredential(fixture.credential)
        const revocations = new RevocationRegistry()
        revocations.revoke(body.revocationCommitment)
        harness.loads = 0
        await wallet.syncCredential("first", async () => ({
            ...fixture.chain,
            revocations,
            revocationRoot: revocations.root
        }))

        expect((await wallet.getCredential("first"))?.status).toBe("revoked")
        expect((await wallet.getCredential("second"))?.status).toBe("valid")
        expect(harness.loads).toBe(0)
    })

    // No sync beforehand: the presentation reads the state it proves against itself.
    it("present stamps the credential from its own load before judging it", async () => {
        const { wallet, harness } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)
        const { body } = parseZkCredential(fixture.credential)
        fixture.chain.revocations.revoke(body.revocationCommitment)
        fixture.chain.revocationRoot = fixture.chain.revocations.root

        await expect(wallet.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "REVOKED"
        })
        expect((await wallet.getCredential(CREDENTIAL_ID))?.status).toBe("revoked")
    })

    it("syncCredential reports a credential it does not hold", async () => {
        const { wallet } = await createWallet(fixture)
        await expect(wallet.syncCredential("missing", async () => fixture.chain)).rejects.toMatchObject({
            code: "NOT_FOUND"
        })
    })

    it("present proves against the presented credential's own issuer, not the issuer left behind by syncing a different one", async () => {
        const other = await issueForTest({ issuerSeed: "wallet-test-issuer-2", revocationSecret: REVOCATION_SECRET_2 })
        const { wallet, proofGenerator, harness } = await createWallet(fixture)
        const approvedIssuers = new ApprovedIssuerSet([
            await fixture.credentialSigner.getPublicKey(),
            await other.credentialSigner.getPublicKey()
        ])
        harness.chain = { ...fixture.chain, approvedIssuers, approvedIssuerRoot: approvedIssuers.root }

        await addFixtureCredential(wallet, fixture, "first")
        await wallet.addCredential({
            id: "second",
            credential: other.credential,
            revocationSecret: other.revocationSecret
        })

        // Sync only "first": afterwards, nothing the wallet holds describes "second"'s issuer.
        await wallet.syncCredential("first", async () => harness.chain)

        await wallet.present("second", other.request, async () => otherChain(other, approvedIssuers))

        const [inputs] = proofGenerator.inputs
        const otherIssuerKey = await other.credentialSigner.getPublicKey()
        expect([BigInt(inputs.issuer_pub_x), BigInt(inputs.issuer_pub_y)]).toEqual(otherIssuerKey)
    })

    // The issuer and the revocation tree a proof carries have to come from one place. Taking the
    // issuer from the credential and the tree from whatever a previous sync left behind was only
    // ever correct by call order.
    it("present proves against the presented credential's own revocation tree, not the one syncing a different one left", async () => {
        const other = await issueForTest({ issuerSeed: "wallet-test-issuer-2", revocationSecret: REVOCATION_SECRET_2 })
        const { wallet, proofGenerator, harness } = await createWallet(fixture)
        const approvedIssuers = new ApprovedIssuerSet([
            await fixture.credentialSigner.getPublicKey(),
            await other.credentialSigner.getPublicKey()
        ])
        // Each issuer has revoked a different stranger, so the two trees answer the same
        // non-membership question with different low leaves.
        fixture.chain.revocations.revoke(111n)
        fixture.chain.revocationRoot = fixture.chain.revocations.root
        other.chain.revocations.revoke(222n)
        other.chain.revocationRoot = other.chain.revocations.root
        harness.chain = { ...fixture.chain, approvedIssuers, approvedIssuerRoot: approvedIssuers.root }

        await addFixtureCredential(wallet, fixture, "first")
        await wallet.addCredential({
            id: "second",
            credential: other.credential,
            revocationSecret: other.revocationSecret
        })
        await wallet.syncCredential("first", async () => harness.chain)

        await wallet.present("second", other.request, async () => otherChain(other, approvedIssuers))

        const commitment = parseZkCredential(other.credential).body.revocationCommitment
        const mine = other.chain.revocations.generateProof(commitment)
        const theirs = fixture.chain.revocations.generateProof(commitment)
        const [inputs] = proofGenerator.inputs
        expect(inputs.revocation_low_leaf_value).toBe(String(mine.leaf.value))
        expect(inputs.revocation_siblings.slice(0, mine.siblings.length)).toEqual(mine.siblings.map(String))
        expect(String(theirs.leaf.value)).not.toBe(inputs.revocation_low_leaf_value)
    })

    it("the background poll refreshes status, reports failures, and stops", async () => {
        jest.useFakeTimers()
        try {
            const { wallet, harness } = await createWallet(fixture)
            await addFixtureCredential(wallet, fixture)
            const { body } = parseZkCredential(fixture.credential)
            fixture.chain.revocations.revoke(body.revocationCommitment)
            fixture.chain.revocationRoot = fixture.chain.revocations.root
            const stop = wallet.startRevocationSync(1_000)
            await jest.advanceTimersByTimeAsync(1_000)
            expect((await wallet.getCredential(CREDENTIAL_ID))?.status).toBe("revoked")

            harness.loadError = new Error("offline")
            await jest.advanceTimersByTimeAsync(1_000)
            expect(harness.syncErrors).toHaveLength(1)

            stop()
            const loads = harness.loads
            await jest.advanceTimersByTimeAsync(5_000)
            expect(harness.loads).toBe(loads)
        } finally {
            jest.useRealTimers()
        }
    })

    it("syncing with nothing held still refreshes the shared public state", async () => {
        const { wallet, harness } = await createWallet(fixture)
        await expect(wallet.syncRevocations()).resolves.toBeUndefined()
        expect(harness.loads).toBe(1)
    })

    it("rejects an invalid identity seed at construction", () => {
        expect(
            () =>
                new Wallet({
                    identitySeed: new Uint8Array(1),
                    deviceSigner: fixture.deviceSigner,
                    consent: async () => true,
                    loadChainState: async () => fixture.chain,
                    proofGenerator: new RecordingProofGenerator()
                })
        ).toThrow(/32 bytes/)
    })

    it("throws WalletError instances with stable codes", () => {
        expect(new WalletError("REVOKED", "no")).toMatchObject({ name: "WalletError", code: "REVOKED" })
    })

    it("keeps the revocation secret out of the credential record, under its own key", async () => {
        // A device store routes by key prefix, and a credential is far too large for a
        // keystore-backed one. If the secret rode inside the credential record it would follow the
        // credential into whatever plain storage held it.
        const { wallet, store } = await createWallet(fixture)
        await addFixtureCredential(wallet, fixture)

        const secretHex = `0x${bytesToHex(fixture.revocationSecret)}`
        const record = await store.get(`vc:${CREDENTIAL_ID}`)
        expect(record).not.toBeNull()
        expect(record).not.toContain(bytesToHex(fixture.revocationSecret))
        expect(await store.get(`revsec:${CREDENTIAL_ID}`)).toBe(secretHex)

        await wallet.deleteCredential(CREDENTIAL_ID)
        expect(await store.get(`revsec:${CREDENTIAL_ID}`)).toBeNull()
    })
})

describe("lazy identity seed", () => {
    let fixture: Fixture

    beforeEach(async () => {
        fixture = await issueForTest()
    })

    function countingSeed(seed: Uint8Array) {
        const seen = { calls: 0 }
        return {
            seen,
            thunk: async () => {
                seen.calls += 1
                return seed
            }
        }
    }

    it("resolves the seed once per addCredential and once per present", async () => {
        const { seen, thunk } = countingSeed(fixture.identitySeed)
        const { wallet, harness } = await createWallet(fixture, { identitySeed: thunk })
        expect(seen.calls).toBe(0)

        await addFixtureCredential(wallet, fixture)
        expect(seen.calls).toBe(1)

        await wallet.present(CREDENTIAL_ID, fixture.request, harness.load)
        expect(seen.calls).toBe(2)
    })

    it("never resolves the seed for listing, reading, syncing or deleting", async () => {
        const { seen, thunk } = countingSeed(fixture.identitySeed)
        const { wallet, harness } = await createWallet(fixture, { identitySeed: thunk })
        await addFixtureCredential(wallet, fixture)
        seen.calls = 0

        await wallet.listCredentials()
        await wallet.getCredential(CREDENTIAL_ID)
        await wallet.syncCredential(CREDENTIAL_ID, harness.load)
        await wallet.deleteCredential(CREDENTIAL_ID)
        expect(seen.calls).toBe(0)
    })

    it("rejects a thunk that returns the wrong length like the bytes path", async () => {
        const { thunk } = countingSeed(new Uint8Array(1))
        const { wallet, harness } = await createWallet(fixture, { identitySeed: thunk })
        await expect(addFixtureCredential(wallet, fixture)).rejects.toThrow(/32 bytes/)

        const good = await createWallet(fixture)
        await addFixtureCredential(good.wallet, fixture)
        const bad = new Wallet({
            identitySeed: thunk,
            deviceSigner: fixture.deviceSigner,
            consent: async () => true,
            loadChainState: harness.load,
            proofGenerator: new RecordingProofGenerator(),
            store: good.store,
            now: () => harness.now
        })
        await expect(bad.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "PRESENTATION_FAILED",
            message: expect.stringMatching(/32 bytes/)
        })
    })

    it("keeps the original error as the cause of a wrapped failure", async () => {
        const failure = new Error("device refused")
        const { wallet, harness } = await createWallet(fixture, {
            identitySeed: async () => {
                throw failure
            }
        })
        await expect(addFixtureCredential(wallet, fixture)).rejects.toMatchObject({
            code: "CREDENTIAL_INVALID",
            cause: failure
        })

        const signerFailure = new Error("signing failed")
        const deviceSigner: DeviceSigner = {
            getPublicKeyJwk: () => fixture.deviceSigner.getPublicKeyJwk(),
            sign: async () => {
                throw signerFailure
            },
            signDigest: async () => {
                throw signerFailure
            }
        }
        const signing = await createWallet(fixture, { deviceSigner })
        await addFixtureCredential(signing.wallet, fixture)
        await expect(signing.wallet.present(CREDENTIAL_ID, fixture.request, harness.load)).rejects.toMatchObject({
            code: "PRESENTATION_FAILED",
            cause: signerFailure
        })
    })
})
