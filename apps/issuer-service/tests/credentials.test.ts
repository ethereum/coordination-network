import assert from "node:assert/strict"
import { mock, test } from "node:test"
import { p256 } from "@noble/curves/nist.js"
import { secp256k1 } from "@noble/curves/secp256k1"
import { bytesToHex, hexToBytes } from "@noble/hashes/utils"
import {
    buildDeviceBindingMessage,
    computeNetworkId,
    deriveEddsaKeypair,
    eddsaPeerPointBytes,
    signAccountBinding
} from "@coordination-network/identity"
import {
    ApprovalResolver,
    deriveRevocationCommitment,
    generateRevocationSecret,
    Hex32,
    InMemoryResolver,
    issuanceRequestCommitment,
    jwkToPublicKeyBytes,
    LocalCredentialSigner,
    LocalP256Signer,
    signCommitmentOwnership,
    signHolderKeyOwnership
} from "@coordination-network/credential"
import { ActivityLog } from "../src/activity"
import { createInMemoryRevocation, RevocationBacking } from "../src/revocation"
import { loadConfig } from "../src/config"
import { buildServer } from "../src/server"
import { InMemoryIssuanceStore } from "../src/stores/issuance-store"
import type { MinimumDeviceSecurityLevel } from "../src/security-level"
import { createAttestationVerifier, type AttestationVerifier } from "../src/attestation"
import { SecurityLevel } from "@peculiar/asn1-android"
import { mintChain, testRoot, testVerifier, withUnloadableKey } from "./attestation-fixtures"
import type { IdentityReader } from "@coordination-network/network-member-client"
import type { IssuancePolicy } from "../src/issuance-policy"

const ISSUER_ID = `0x${"ff".repeat(32)}` as Hex32
const OTHER_ISSUER_ID = `0x${"fe".repeat(32)}` as Hex32
const SUBJECT_ID = `0x${"ee".repeat(32)}` as Hex32
const ACCOUNT_PRIVATE_KEY = hexToBytes("21".repeat(32))
const DEVICE_PRIVATE_KEY = hexToBytes("23".repeat(32))
const LISTING_SUBJECT_ID = computeNetworkId(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, false)) as Hex32

// Shaped to pass credentialsBody's zod schema; none of its crypto is ever checked, since
// `approval.isApprovedNetworkMember` in these tests rejects or throws before issueZkCredential
// gets that far.
const ISSUE_BODY = {
    subjectNetworkId: SUBJECT_ID,
    approvalScope: { programme: "demo-programme", country: "ZZZ" },
    confirmationKey: { kty: "EC", crv: "P-256", x: "eA", y: "eQ" },
    accountPublicKey: "0x00",
    devicePopSignature: "0x00",
    accountPopSignature: "0x00",
    identityPublicKey: ["1", "2"],
    identityOwnershipSignature: { R8: ["1", "2"], S: "1" },
    revocation: {
        commitment: "1",
        publicKey: ["1", "2"],
        ownershipSignature: { R8: ["1", "2"], S: "1" }
    }
}

async function buildValidIssueBody(nonce: Uint8Array, approvalScope = ISSUE_BODY.approvalScope) {
    const deviceSigner = new LocalP256Signer(DEVICE_PRIVATE_KEY)
    const confirmationKey = await deviceSigner.getPublicKeyJwk()
    const holder = deriveEddsaKeypair(p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33))
    const revocationSecret = generateRevocationSecret()
    const ownership = signCommitmentOwnership(revocationSecret, nonce)
    const holderOwnership = signHolderKeyOwnership(hexToBytes(holder.seed.slice(2)), nonce)
    return {
        subjectNetworkId: LISTING_SUBJECT_ID,
        approvalScope,
        confirmationKey,
        accountPublicKey: bytesToHex(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, true)),
        devicePopSignature: bytesToHex(
            await deviceSigner.sign(
                buildDeviceBindingMessage(
                    nonce,
                    LISTING_SUBJECT_ID,
                    hexToBytes(holder.commitment.toString(16).padStart(64, "0")),
                    issuanceRequestCommitment(ISSUER_ID, approvalScope)
                )
            )
        ),
        accountPopSignature: signAccountBinding(
            ACCOUNT_PRIVATE_KEY,
            nonce,
            jwkToPublicKeyBytes(confirmationKey)
        ).signature.slice(2),
        identityPublicKey: holder.publicKey.map(String),
        identityOwnershipSignature: {
            R8: holderOwnership.signature.R8.map(String),
            S: holderOwnership.signature.S.toString()
        },
        revocation: {
            commitment: deriveRevocationCommitment(revocationSecret).toString(),
            publicKey: ownership.publicKey.map(String),
            ownershipSignature: { R8: ownership.signature.R8.map(String), S: ownership.signature.S.toString() }
        }
    }
}

async function issue(
    approval: ApprovalResolver,
    activityLog: ActivityLog,
    body: object = ISSUE_BODY,
    eligibility?: { identityReader: IdentityReader; issuancePolicy: IssuancePolicy },
    validBinding = false,
    mutateBody?: (body: Awaited<ReturnType<typeof buildValidIssueBody>>) => object,
    challengeSubject = validBinding ? LISTING_SUBJECT_ID : SUBJECT_ID
): Promise<Response> {
    const signer = new LocalCredentialSigner("issuer-service-credentials-unit")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        approval,
        activityLog,
        minDeviceSecurityLevel: "SOFTWARE",
        ...eligibility
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`
    try {
        const challengeRes = await fetch(`${base}/v1/challenge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subjectNetworkId: challengeSubject })
        })
        assert.equal(challengeRes.status, 200)
        const { challengeId, nonce: nonceHex } = (await challengeRes.json()) as {
            challengeId: string
            nonce: string
        }
        const validBody = validBinding ? await buildValidIssueBody(hexToBytes(nonceHex)) : undefined
        const requestBody = validBody ? (mutateBody ? mutateBody(validBody) : validBody) : body
        return await fetch(`${base}/v1/credentials`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ...requestBody, challengeId })
        })
    } finally {
        listener.close()
    }
}

test("rejects a holder-key ownership signature from a different identity", async () => {
    const res = await issue(
        { isApprovedNetworkMember: async () => true },
        new ActivityLog(),
        ISSUE_BODY,
        undefined,
        true,
        (body) => ({
            ...body,
            identityOwnershipSignature: {
                R8: body.revocation.ownershipSignature.R8,
                S: body.revocation.ownershipSignature.S
            }
        })
    )

    assert.equal(res.status, 400)
    assert.equal(((await res.json()) as { code: string }).code, "HOLDER_KEY_OWNERSHIP_INVALID")
})

test("409s without signing when the subject enrolment is not confirmed", async () => {
    let policyCalls = 0
    const res = await issue(
        { isApprovedNetworkMember: async () => true },
        new ActivityLog(),
        ISSUE_BODY,
        {
            identityReader: { getIdentity: async () => null },
            issuancePolicy: {
                decideIssuance: async () => {
                    policyCalls += 1
                    return ISSUE_BODY.approvalScope
                }
            }
        },
        true
    )

    assert.equal(res.status, 409)
    assert.equal(((await res.json()) as { code: string }).code, "SUBJECT_ENROLMENT_PENDING")
    assert.equal(policyCalls, 0)
})

test("403s when the member policy refuses the enrolled subject", async () => {
    const res = await issue(
        { isApprovedNetworkMember: async () => true },
        new ActivityLog(),
        ISSUE_BODY,
        {
            identityReader: { getIdentity: async () => "0x1234" },
            issuancePolicy: { decideIssuance: async () => null }
        },
        true
    )

    assert.equal(res.status, 403)
    assert.equal(((await res.json()) as { code: string }).code, "SUBJECT_NOT_ELIGIBLE")
})

test("403s when the requested scope exceeds the member policy", async () => {
    const res = await issue(
        { isApprovedNetworkMember: async () => true },
        new ActivityLog(),
        ISSUE_BODY,
        {
            identityReader: { getIdentity: async () => "0x1234" },
            issuancePolicy: { decideIssuance: async () => ({ programme: "other-programme", country: "XAA" }) }
        },
        true
    )

    assert.equal(res.status, 403)
    assert.equal(((await res.json()) as { code: string }).code, "SUBJECT_NOT_ELIGIBLE")
})

test("400s and tags the activity entry 'failed' when the issuer is not an approved network member", async () => {
    const activityLog = new ActivityLog()
    const res = await issue({ isApprovedNetworkMember: async () => false }, activityLog)

    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { error: "issuance refused", code: "ISSUANCE_REFUSED" })
    assert.deepEqual(
        activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
        [{ kind: "credential", message: "issuance rejected: ISSUER_NOT_APPROVED", outcome: "failed" }]
    )
})

test("400s, not 500s, on odd-length hex in a byte field", async () => {
    const res = await issue({ isApprovedNetworkMember: async () => true }, new ActivityLog(), {
        ...ISSUE_BODY,
        accountPublicKey: "0xabc"
    })

    assert.equal(res.status, 400)
    assert.deepEqual(await res.json(), { error: "issuance refused", code: "ISSUANCE_REFUSED" })
})

test("invalid proofs and subject mismatch have the same opaque response", async () => {
    const approval = { isApprovedNetworkMember: async () => true }
    const refused = { error: "issuance refused", code: "ISSUANCE_REFUSED" }
    const responses = await Promise.all([
        issue(approval, new ActivityLog(), { subjectNetworkId: SUBJECT_ID }),
        issue(approval, new ActivityLog(), { ...ISSUE_BODY, accountPublicKey: "0xabc" }),
        issue(approval, new ActivityLog(), ISSUE_BODY, undefined, true, (body) => ({
            ...body,
            devicePopSignature: "00"
        })),
        issue(
            approval,
            new ActivityLog(),
            ISSUE_BODY,
            undefined,
            true,
            (body) => ({
                ...body,
                subjectNetworkId: SUBJECT_ID
            }),
            SUBJECT_ID
        )
    ])
    for (const response of responses) {
        assert.equal(response.status, 400)
        assert.deepEqual(await response.json(), refused)
    }
})

test("missing and replaced challenges have the same opaque response", async () => {
    const signer = new LocalCredentialSigner("issuer-service-opaque-challenges")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    let challengeAvailable = false
    let consumed = false
    const nonce = hexToBytes("01".repeat(32))
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        approval: { isApprovedNetworkMember: async () => true },
        identityReader: { getIdentity: async () => "0x1234" },
        issuancePolicy: { decideIssuance: async () => ISSUE_BODY.approvalScope },
        minDeviceSecurityLevel: "SOFTWARE",
        nonceStore: {
            issue: async (subjectNetworkId) => ({
                challengeId: "00000000-0000-4000-8000-000000000001",
                subjectNetworkId,
                nonce,
                expiresAt: Date.now() + 60000
            }),
            get: async () => (challengeAvailable ? nonce : null),
            consume: async () => {
                consumed = true
                return false
            }
        }
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const url = `http://127.0.0.1:${port}/v1/credentials`
    const body = JSON.stringify({
        ...(await buildValidIssueBody(nonce)),
        challengeId: "00000000-0000-4000-8000-000000000001"
    })
    try {
        const missing = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })
        challengeAvailable = true
        const replaced = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body })
        assert.equal(consumed, true, JSON.stringify(await replaced.clone().json()))
        for (const response of [missing, replaced]) {
            assert.equal(response.status, 400)
            assert.deepEqual(await response.json(), { error: "issuance refused", code: "ISSUANCE_REFUSED" })
        }
    } finally {
        listener.close()
    }
})

/** A full holder-side dance that actually succeeds, for the listing test below: it needs a real
 *  issued credential, not one of the rejections `issue` above stops short of. */
async function postIssuance(
    base: string,
    approvalScope: { programme: string; country: string },
    signedScope = approvalScope,
    signedIssuerId = ISSUER_ID
): Promise<Response> {
    const deviceSigner = new LocalP256Signer(DEVICE_PRIVATE_KEY)
    const confirmationKey = await deviceSigner.getPublicKeyJwk()
    const holder = deriveEddsaKeypair(p256.getSharedSecret(DEVICE_PRIVATE_KEY, eddsaPeerPointBytes()).slice(1, 33))
    const revocationSecret = generateRevocationSecret()

    const challengeRes = await fetch(`${base}/v1/challenge`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ subjectNetworkId: LISTING_SUBJECT_ID })
    })
    const { challengeId, nonce: nonceHex } = (await challengeRes.json()) as { challengeId: string; nonce: string }
    const nonce = hexToBytes(nonceHex)
    const ownership = signCommitmentOwnership(revocationSecret, nonce)
    const holderOwnership = signHolderKeyOwnership(hexToBytes(holder.seed.slice(2)), nonce)

    return fetch(`${base}/v1/credentials`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            challengeId,
            subjectNetworkId: LISTING_SUBJECT_ID,
            approvalScope,
            confirmationKey,
            accountPublicKey: bytesToHex(secp256k1.getPublicKey(ACCOUNT_PRIVATE_KEY, true)),
            devicePopSignature: bytesToHex(
                await deviceSigner.sign(
                    buildDeviceBindingMessage(
                        nonce,
                        LISTING_SUBJECT_ID,
                        hexToBytes(holder.commitment.toString(16).padStart(64, "0")),
                        issuanceRequestCommitment(signedIssuerId, signedScope)
                    )
                )
            ),
            accountPopSignature: signAccountBinding(
                ACCOUNT_PRIVATE_KEY,
                nonce,
                jwkToPublicKeyBytes(confirmationKey)
            ).signature.slice(2),
            identityPublicKey: holder.publicKey.map(String),
            identityOwnershipSignature: {
                R8: holderOwnership.signature.R8.map(String),
                S: holderOwnership.signature.S.toString()
            },
            revocation: {
                commitment: deriveRevocationCommitment(revocationSecret).toString(),
                publicKey: ownership.publicKey.map(String),
                ownershipSignature: { R8: ownership.signature.R8.map(String), S: ownership.signature.S.toString() }
            }
        })
    })
}

async function issueReal(base: string, approvalScope: { programme: string; country: string }): Promise<string> {
    const res = await postIssuance(base, approvalScope)
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()))
    return ((await res.json()) as { id: string }).id
}

const BOUND_SCOPE = { programme: "demo-programme", country: "ZZZ" }

for (const [name, signedScope, signedIssuerId] of [
    ["scope", { programme: "other-programme", country: "ZZZ" }, ISSUER_ID],
    ["issuer", BOUND_SCOPE, OTHER_ISSUER_ID]
] as const) {
    test(`POST /v1/credentials refuses a binding signed for a different ${name}`, async () => {
        const resolver = new InMemoryResolver()
        resolver.approveMember(ISSUER_ID)
        const app = buildServer({
            issuerNetworkId: ISSUER_ID,
            signer: new LocalCredentialSigner(`issuer-service-credentials-${name}`),
            resolver
        })
        const listener = app.listen(0)
        const { port } = listener.address() as { port: number }

        try {
            const res = await postIssuance(`http://127.0.0.1:${port}`, BOUND_SCOPE, signedScope, signedIssuerId)

            assert.equal(res.status, 400)
            assert.equal(((await res.json()) as { code: string }).code, "BINDING_INVALID")
        } finally {
            listener.close()
        }
    })
}

test("GET /v1/credentials lists every issued credential, with its revoked status but no subject", async () => {
    const signer = new LocalCredentialSigner("issuer-service-credentials-listing")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const issuanceStore = new InMemoryIssuanceStore()
    const approvedScopes = [
        { programme: "demo-programme", country: "ZZZ" },
        { programme: "other-programme", country: "XAA" }
    ]
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer,
        resolver,
        issuanceStore,
        identityReader: { getIdentity: async () => "0x1234" },
        issuancePolicy: { decideIssuance: async () => approvedScopes.shift() ?? null },
        minDeviceSecurityLevel: "SOFTWARE"
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`

    const clock = mock.method(Date, "now", () => 1_800_000_123_000)
    try {
        const keptId = await issueReal(base, { programme: "demo-programme", country: "ZZZ" })
        const revokedId = await issueReal(base, { programme: "other-programme", country: "XAA" })
        const stored = await issuanceStore.get(keptId)
        assert.equal(typeof stored?.deviceKeyCommitment, "string")
        assert.ok(stored && !("confirmationKey" in stored))
        assert.equal((await fetch(`${base}/v1/credentials/${revokedId}/revoke`, { method: "POST" })).status, 200)

        const res = await fetch(`${base}/v1/credentials`)
        assert.equal(res.status, 200)
        const { credentials } = (await res.json()) as {
            credentials: {
                id: string
                programme: string
                country: string
                issuedAt: number
                expiresAt: number
                revoked: boolean
            }[]
        }

        assert.equal(credentials.length, 2)
        for (const credential of credentials) {
            assert.ok(!("subjectNetworkId" in credential))
        }
        const kept = credentials.find((c) => c.id === keptId)
        const revoked = credentials.find((c) => c.id === revokedId)
        // Two issuances on one day must not encode their exact issuance seconds.
        assert.equal(kept?.issuedAt, revoked?.issuedAt)
        assert.equal(kept?.expiresAt, revoked?.expiresAt)
        assert.equal((kept?.issuedAt ?? -1) % 86_400, 0)
        assert.deepEqual(kept && { programme: kept.programme, country: kept.country, revoked: kept.revoked }, {
            programme: "demo-programme",
            country: "ZZZ",
            revoked: false
        })
        assert.deepEqual(
            revoked && { programme: revoked.programme, country: revoked.country, revoked: revoked.revoked },
            { programme: "other-programme", country: "XAA", revoked: true }
        )
    } finally {
        clock.mock.restore()
        listener.close()
    }
})

/** `isRevoked` is a chain read on the chain-backed backing, and the dashboard polls the listing
 *  per org every two seconds, so this counts what a listing would cost. */
function countingRevocation(): { backing: RevocationBacking; chainReads: () => number } {
    const inner = createInMemoryRevocation(new InMemoryResolver())
    let chainReads = 0
    return {
        backing: {
            ...inner,
            isRevoked: (commitment: bigint) => {
                chainReads += 1
                return inner.isRevoked(commitment)
            }
        },
        chainReads: () => chainReads
    }
}

test("GET /v1/credentials reports revocation from the mirror, without a chain read per credential", async () => {
    const { backing, chainReads } = countingRevocation()
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const issuanceStore = new InMemoryIssuanceStore()
    const jti = "urn:uuid:credentials-listing-mirror"
    await issuanceStore.save({
        jti,
        subjectNetworkId: SUBJECT_ID,
        approvalScope: { programme: "demo-programme", country: "ZZZ" },
        nbf: 0,
        exp: Math.floor(Date.now() / 1000) + 60,
        deviceKeyCommitment: "1",
        revocationCommitment: "424242"
    })
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer: new LocalCredentialSigner("issuer-service-credentials-listing-mirror"),
        resolver,
        revocation: backing,
        issuanceStore
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`

    const listedAsRevoked = async () => {
        const res = await fetch(`${base}/v1/credentials`)
        assert.equal(res.status, 200)
        return ((await res.json()) as { credentials: { revoked: boolean }[] }).credentials[0].revoked
    }

    try {
        assert.equal(await listedAsRevoked(), false)
        assert.equal(chainReads(), 0)

        assert.equal((await fetch(`${base}/v1/credentials/${jti}/revoke`, { method: "POST" })).status, 200)
        const afterRevoke = chainReads()

        assert.equal(await listedAsRevoked(), true)
        assert.equal(chainReads(), afterRevoke)
    } finally {
        listener.close()
    }
})

test("GET /v1/credentials/:id names neither the holder nor the commitment that identifies its credential", async () => {
    const signer = new LocalCredentialSigner("issuer-service-credentials-by-id")
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const issuanceStore = new InMemoryIssuanceStore()
    const expiresAt = Math.floor(Date.now() / 1000) + 60
    await issuanceStore.save({
        jti: "urn:uuid:credentials-by-id",
        subjectNetworkId: SUBJECT_ID,
        approvalScope: { programme: "demo-programme", country: "ZZZ" },
        nbf: 0,
        exp: expiresAt,
        deviceKeyCommitment: "1",
        revocationCommitment: "123456789"
    })
    const app = buildServer({ issuerNetworkId: ISSUER_ID, signer, resolver, issuanceStore })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }

    try {
        const res = await fetch(`http://127.0.0.1:${port}/v1/credentials/urn:uuid:credentials-by-id`)
        assert.equal(res.status, 200)
        assert.deepEqual(await res.json(), {
            id: "urn:uuid:credentials-by-id",
            approvalScope: { programme: "demo-programme", country: "ZZZ" },
            nbf: 0,
            exp: expiresAt,
            revoked: false
        })
    } finally {
        listener.close()
    }
})

test("500s and tags the activity entry 'failed' when the approval check itself throws", async () => {
    const activityLog = new ActivityLog()
    const res = await issue(
        {
            isApprovedNetworkMember: async () => {
                throw new Error("approval backend unreachable")
            }
        },
        activityLog
    )

    assert.equal(res.status, 500)
    assert.deepEqual(
        activityLog.recent().map(({ kind, message, outcome }) => ({ kind, message, outcome })),
        [{ kind: "credential", message: "issuance failed", outcome: "failed" }]
    )
})

const ENROLLED: IdentityReader = { getIdentity: async () => "0x1234" }
const DEVICE_KEY_XY = p256.getPublicKey(DEVICE_PRIVATE_KEY, false).slice(1)
const REJECTED = { error: "device key attestation rejected", code: "DEVICE_ATTESTATION_REJECTED" }
const UNAVAILABLE = {
    error: "device key attestation cannot be checked right now; retry later",
    code: "DEVICE_ATTESTATION_UNAVAILABLE"
}

interface AttestationOptions {
    minDeviceSecurityLevel?: MinimumDeviceSecurityLevel
    /** Defaults to one anchored at the test root with a fresh status list. Null leaves buildServer's own. */
    deviceAttestation?: AttestationVerifier | null
    identityReader?: IdentityReader
    issuanceStore?: InMemoryIssuanceStore
    issuancePolicy?: IssuancePolicy
}

/** Runs `run` against a server with a real holder binding. `post` reuses one challenge, so a
 *  refusal can be followed by a retry. */
async function withChallenge(
    {
        minDeviceSecurityLevel,
        deviceAttestation,
        identityReader = ENROLLED,
        issuanceStore,
        issuancePolicy
    }: AttestationOptions,
    run: (ctx: { activityLog: ActivityLog; post: (overrides?: object) => Promise<Response> }) => Promise<void>
): Promise<void> {
    const activityLog = new ActivityLog()
    const resolver = new InMemoryResolver()
    resolver.approveMember(ISSUER_ID)
    const app = buildServer({
        issuerNetworkId: ISSUER_ID,
        signer: new LocalCredentialSigner("issuer-service-credentials-attestation"),
        resolver,
        approval: { isApprovedNetworkMember: async () => true },
        activityLog,
        identityReader,
        issuancePolicy: issuancePolicy ?? { decideIssuance: async () => ISSUE_BODY.approvalScope },
        issuanceStore,
        minDeviceSecurityLevel,
        deviceAttestation: deviceAttestation === null ? undefined : (deviceAttestation ?? (await testVerifier()))
    })
    const listener = app.listen(0)
    const { port } = listener.address() as { port: number }
    const base = `http://127.0.0.1:${port}`
    try {
        const challengeRes = await fetch(`${base}/v1/challenge`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ subjectNetworkId: LISTING_SUBJECT_ID })
        })
        const { challengeId, nonce } = (await challengeRes.json()) as { challengeId: string; nonce: string }
        const valid = await buildValidIssueBody(hexToBytes(nonce))
        await run({
            activityLog,
            post: (overrides = {}) =>
                fetch(`${base}/v1/credentials`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ ...valid, challengeId, ...overrides })
                })
        })
    } finally {
        listener.close()
    }
}

const attested = async (options: Partial<Parameters<typeof mintChain>[0]> = {}) => ({
    deviceAttestation: (await mintChain({ confirmationKeyXY: DEVICE_KEY_XY, ...options })).chain
})

test("issues against an attested chain for the confirmation key", async () => {
    await withChallenge({}, async ({ post }) => {
        const res = await post(await attested())
        assert.equal(res.status, 201, JSON.stringify(await res.clone().json()))
    })
})

test("a missing or empty chain is refused without spending the challenge", async () => {
    await withChallenge({}, async ({ activityLog, post }) => {
        for (const overrides of [{}, { deviceAttestation: [] }]) {
            const res = await post(overrides)
            assert.equal(res.status, 400)
            assert.deepEqual(await res.json(), REJECTED)
        }
        assert.deepEqual(
            activityLog.recent().map(({ message, outcome }) => ({ message, outcome })),
            [
                { message: "issuance rejected: DEVICE_ATTESTATION_REJECTED", outcome: "failed" },
                { message: "issuance rejected: DEVICE_ATTESTATION_REJECTED", outcome: "failed" }
            ]
        )
        assert.equal((await post(await attested())).status, 201)
    })
})

test("a chain that fails verification is refused without spending the challenge", async () => {
    const refused = [
        await attested({ hardware: { noAuthRequired: null } }),
        await attested({ hardware: { authTimeout: 0 } }),
        await attested({ hangBelowAttestedKey: true }),
        await attested({ confirmationKeyXY: p256.getPublicKey(hexToBytes("24".repeat(32)), false).slice(1) }),
        { deviceAttestation: ["AAAA"] }
    ]
    await withChallenge({}, async ({ post }) => {
        for (const overrides of refused) {
            const res = await post(overrides)
            assert.equal(res.status, 400)
            assert.deepEqual(await res.json(), REJECTED)
        }
        assert.equal((await post(await attested())).status, 201)
    })
})

test("a chain whose keys OpenSSL cannot load is a 400, not a 500", async () => {
    const { chain } = await mintChain({ confirmationKeyXY: DEVICE_KEY_XY })
    const unloadableRoot = [...chain.slice(0, -1), withUnloadableKey(chain[chain.length - 1])]
    const unloadableLeaf = (await attested({ unloadableLeafKey: true })).deviceAttestation
    await withChallenge({}, async ({ post }) => {
        for (const deviceAttestation of [unloadableRoot, unloadableLeaf]) {
            const res = await post({ deviceAttestation })
            assert.equal(res.status, 400)
            assert.deepEqual(await res.json(), REJECTED)
        }
        assert.equal((await post(await attested())).status, 201)
    })
})

test("a revoked chain is refused", async () => {
    const { chain, serials } = await mintChain({ confirmationKeyXY: DEVICE_KEY_XY })
    await withChallenge({ deviceAttestation: await testVerifier({ revoked: [serials[2]] }) }, async ({ post }) => {
        const res = await post({ deviceAttestation: chain })
        assert.equal(res.status, 400)
        assert.deepEqual(await res.json(), REJECTED)
    })
})

test("an attested level below the minimum is refused", async () => {
    await withChallenge({ minDeviceSecurityLevel: "STRONGBOX" }, async ({ post }) => {
        const res = await post(await attested())
        assert.equal(res.status, 400)
        assert.deepEqual(await res.json(), REJECTED)
        const strongBox = await attested({
            securityLevel: SecurityLevel.strongBox,
            attestationOrganization: "StrongBox"
        })
        assert.equal((await post(strongBox)).status, 201)
    })
})

test("answers 503 while the status list is unavailable, and issues once it is back", async () => {
    let available = false
    const deviceAttestation = createAttestationVerifier({
        roots: [await testRoot()],
        statusList: {
            snapshot: () => (available ? { serials: new Set(), fetchedAt: Date.now() } : { unavailable: "stale" })
        }
    })
    const chain = await attested()
    await withChallenge({ deviceAttestation }, async ({ activityLog, post }) => {
        const res = await post(chain)
        assert.equal(res.status, 503)
        assert.deepEqual(await res.json(), UNAVAILABLE)
        assert.equal(activityLog.recent()[0].message, "issuance rejected: DEVICE_ATTESTATION_UNAVAILABLE")

        // No chain is a 400 whatever the list's state.
        const missing = await post()
        assert.equal(missing.status, 400)
        assert.deepEqual(await missing.json(), REJECTED)

        available = true
        assert.equal((await post(chain)).status, 201)
    })
})

test("a SOFTWARE minimum takes no chain and never runs the verifier", async () => {
    let verified = 0
    const deviceAttestation: AttestationVerifier = {
        verify: () => {
            verified += 1
            return { ok: false, reason: "UNTRUSTED_ROOT" }
        },
        statusListState: () => "never-fetched"
    }
    await withChallenge({ minDeviceSecurityLevel: "SOFTWARE", deviceAttestation }, async ({ post }) => {
        assert.equal((await post()).status, 201)
    })
    await withChallenge({ minDeviceSecurityLevel: "SOFTWARE", deviceAttestation }, async ({ post }) => {
        assert.equal((await post({ deviceAttestation: ["AAAA"] })).status, 201)
    })
    assert.equal(verified, 0)
})

test("an old client's deviceSecurityLevel is ignored", async () => {
    await withChallenge({}, async ({ post }) => {
        const claimed = await post({ deviceSecurityLevel: "STRONGBOX" })
        assert.equal(claimed.status, 400)
        assert.deepEqual(await claimed.json(), REJECTED)
        assert.equal((await post({ ...(await attested()), deviceSecurityLevel: "SOFTWARE" })).status, 201)
    })
})

test("a malformed deviceAttestation is an opaque 400 that leaves the challenge unconsumed", async () => {
    const chain = await attested()
    await withChallenge({}, async ({ post }) => {
        for (const bad of ["AAAA", [123], [""], ["not base64!"], ["AAA"], [null], Array(11).fill("AAAA")]) {
            const res = await post({ deviceAttestation: bad })
            assert.equal(res.status, 400, JSON.stringify(bad))
            assert.deepEqual(
                await res.json(),
                { error: "issuance refused", code: "ISSUANCE_REFUSED" },
                JSON.stringify(bad)
            )
        }
        assert.equal((await post(chain)).status, 201)
    })
})

test("checks the holder proof before the attestation", async () => {
    await withChallenge({}, async ({ post }) => {
        const res = await post({ devicePopSignature: "00" })
        assert.equal(res.status, 400)
        assert.notEqual(((await res.json()) as { code: string }).code, "DEVICE_ATTESTATION_REJECTED")
    })
})

test("a refused chain leaves no record and never reaches the enrolment or policy lookups", async () => {
    let identityLookups = 0
    let policyDecisions = 0
    const issuanceStore = new InMemoryIssuanceStore()
    const identityReader: IdentityReader = {
        getIdentity: async () => {
            identityLookups += 1
            return "0x1234"
        }
    }
    const issuancePolicy: IssuancePolicy = {
        decideIssuance: async () => {
            policyDecisions += 1
            return ISSUE_BODY.approvalScope
        }
    }
    await withChallenge({ identityReader, issuanceStore, issuancePolicy }, async ({ post }) => {
        assert.equal((await post()).status, 400)
        assert.deepEqual(await issuanceStore.list(), [])
        assert.equal(identityLookups, 0)
        assert.equal(policyDecisions, 0)

        assert.equal((await post(await attested())).status, 201)
        assert.equal((await issuanceStore.list()).length, 1)
        assert.equal(identityLookups, 1)
        assert.equal(policyDecisions, 1)
    })
})

test("checks the attestation before the enrolment lookup", async () => {
    await withChallenge({ identityReader: { getIdentity: async () => null } }, async ({ post }) => {
        const res = await post()
        assert.equal(res.status, 400)
        assert.deepEqual(await res.json(), REJECTED)
    })
})

test("without an injected verifier, issuance fails closed on Google's roots and an unfetched list", async () => {
    const chain = await attested()
    await withChallenge({ deviceAttestation: null }, async ({ post }) => {
        const res = await post(chain)
        assert.equal(res.status, 503)
        assert.deepEqual(await res.json(), UNAVAILABLE)
        assert.equal((await post()).status, 400)
    })
})

test("logs the refusal reason and cert index to the console, and nothing from the chain", async (t) => {
    const warn = t.mock.method(console, "warn", () => {})
    const { chain, serials } = await mintChain({ confirmationKeyXY: DEVICE_KEY_XY })
    const deviceAttestation = await testVerifier({ revoked: [serials[3]] })
    await withChallenge({ deviceAttestation }, async ({ activityLog, post }) => {
        assert.equal((await post({ deviceAttestation: chain })).status, 400)
        assert.equal(activityLog.recent()[0].message, "issuance rejected: DEVICE_ATTESTATION_REJECTED")
    })
    assert.deepEqual(
        warn.mock.calls.map((call) => call.arguments.join(" ")),
        ["device attestation rejected: CERT_REVOKED at cert 3"]
    )
})

test("a floor read by loadConfig and passed to buildServer is the one the route enforces", async () => {
    const { minDeviceSecurityLevel } = loadConfig({
        MIN_DEVICE_SECURITY_LEVEL: "STRONGBOX",
        ALLOW_IN_MEMORY_REVOCATION: "true",
        MEMBER_SERVER_TOKEN: "t".repeat(16)
    })
    await withChallenge({ minDeviceSecurityLevel }, async ({ post }) => {
        const refused = await post(await attested())
        assert.equal(refused.status, 400)
        assert.deepEqual(await refused.json(), REJECTED)
        const strongBox = await attested({
            securityLevel: SecurityLevel.strongBox,
            attestationOrganization: "StrongBox"
        })
        assert.equal((await post(strongBox)).status, 201)
    })
})
