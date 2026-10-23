import assert from "node:assert/strict"
import { test } from "node:test"
import { p256 } from "@noble/curves/nist.js"
import { SecurityLevel, RootOfTrust, VerifiedBootState } from "@peculiar/asn1-android"
import { OctetString } from "@peculiar/asn1-schema"
import { GOOGLE_ATTESTATION_ROOTS, createAttestationVerifier } from "../src/attestation"
import { loadFixture, mintChain, testVerifier, type MintOptions } from "./attestation-fixtures"

const KEY_XY = p256.getPublicKey(p256.utils.randomPrivateKey(), false).slice(1)
const OTHER_KEY_XY = p256.getPublicKey(p256.utils.randomPrivateKey(), false).slice(1)

const rootOfTrust = (deviceLocked: boolean, verifiedBootState: VerifiedBootState) =>
    new RootOfTrust({ verifiedBootKey: new OctetString(32), deviceLocked, verifiedBootState })

async function verifyMinted(options: Partial<MintOptions> = {}, keyXY = KEY_XY) {
    const { chain } = await mintChain({ confirmationKeyXY: KEY_XY, ...options })
    return (await testVerifier()).verify(chain, keyXY)
}

test("accepts a per-use chain for the confirmation key at its attested level", async () => {
    assert.deepEqual(await verifyMinted(), { ok: true, level: "TRUSTED_ENVIRONMENT" })
    assert.deepEqual(
        await verifyMinted({ securityLevel: SecurityLevel.strongBox, attestationOrganization: "StrongBox" }),
        { ok: true, level: "STRONGBOX" }
    )
})

for (const [name, options, reason] of [
    ["an auth timeout", { hardware: { authTimeout: 0 } }, "AUTH_TIMEOUT"],
    ["noAuthRequired", { hardware: { noAuthRequired: null } }, "NO_AUTH_REQUIRED"],
    [
        "an unlocked bootloader",
        { hardware: { rootOfTrust: rootOfTrust(false, VerifiedBootState.verified) } },
        "DEVICE_UNLOCKED"
    ],
    [
        "a SelfSigned boot",
        { hardware: { rootOfTrust: rootOfTrust(true, VerifiedBootState.selfSigned) } },
        "BOOT_NOT_VERIFIED"
    ],
    ["a software key", { securityLevel: SecurityLevel.software }, "SOFTWARE_LEVEL"],
    [
        "a wrong challenge",
        { challenge: new TextEncoder().encode("urn:cn:device-attestation:v0") },
        "CHALLENGE_MISMATCH"
    ],
    [
        "a StrongBox claim under a TEE attestation cert",
        { securityLevel: SecurityLevel.strongBox },
        "SECURITY_LEVEL_MISMATCH"
    ]
] as const) {
    test(`refuses ${name}`, async () => {
        assert.deepEqual(await verifyMinted(options), { ok: false, reason })
    })
}

test("refuses a chain for a different key", async () => {
    assert.deepEqual(await verifyMinted({}, OTHER_KEY_XY), { ok: false, reason: "LEAF_KEY_MISMATCH", certIndex: 0 })
})

test("refuses a chain with a revoked intermediate", async () => {
    const { chain, serials } = await mintChain({ confirmationKeyXY: KEY_XY })
    assert.deepEqual((await testVerifier({ revoked: [serials[3]] })).verify(chain, KEY_XY), {
        ok: false,
        reason: "CERT_REVOKED",
        certIndex: 3
    })
})

test("refuses a leaf hung below an attested key", async () => {
    assert.deepEqual(await verifyMinted({ hangBelowAttestedKey: true }), {
        ok: false,
        reason: "EXTENSION_MISPLACED",
        certIndex: 1
    })
})

test("answers unavailable, before reading the chain, while the status list is stale or missing", async () => {
    const { chain } = await mintChain({ confirmationKeyXY: KEY_XY })
    for (const unavailable of ["stale", "never-fetched"] as const) {
        const verifier = await testVerifier({ unavailable })
        assert.deepEqual(verifier.verify(chain, KEY_XY), { ok: false, reason: "STATUS_LIST_UNAVAILABLE" })
        assert.deepEqual(verifier.verify(["AAAA"], KEY_XY), { ok: false, reason: "STATUS_LIST_UNAVAILABLE" })
        assert.equal(verifier.statusListState(), unavailable)
    }
    assert.equal((await testVerifier()).statusListState(), "fresh")
})

test("reports a malformed key description at the leaf", async () => {
    const { chain } = await mintChain({
        confirmationKeyXY: KEY_XY,
        mangleKeyDescription: (der) => Uint8Array.from([...der, 0x05, 0x00])
    })
    assert.deepEqual((await testVerifier()).verify(chain, KEY_XY), {
        ok: false,
        reason: "KEY_DESCRIPTION_MALFORMED",
        certIndex: 0
    })
})

test("refuses, rather than throws on, a leaf whose key OpenSSL cannot load", async () => {
    assert.deepEqual(await verifyMinted({ unloadableLeafKey: true }), { ok: false, reason: "MALFORMED_CHAIN" })
})

test("logs an unexpected throw by name and frames, never its message or the chain", async (t) => {
    const warn = t.mock.method(console, "warn", () => {})
    const { chain } = await mintChain({ confirmationKeyXY: KEY_XY })
    // A message can quote parsed values; this one quotes the leaf.
    const throwingRoot = {
        factory: false,
        get spki(): Buffer {
            throw Object.assign(new Error(`cannot read ${chain[0]}`), { name: "LibraryRegression" })
        }
    }
    const verifier = createAttestationVerifier({
        roots: [throwingRoot],
        statusList: { snapshot: () => ({ serials: new Set(), fetchedAt: 0 }) }
    })
    assert.deepEqual(verifier.verify(chain, KEY_XY), { ok: false, reason: "MALFORMED_CHAIN" })
    const lines = warn.mock.calls.map((call) => call.arguments.join(" "))
    assert.equal(lines.length, 1)
    assert.match(lines[0], /MALFORMED_CHAIN.*LibraryRegression.* at .*verify-chain\.ts/)
    assert.doesNotMatch(lines[0], /cannot read/)
    for (const cert of chain) assert.ok(!lines[0].includes(cert.slice(0, 40)), lines[0])
})

test("the production roots refuse Google's own test keys on the challenge", () => {
    const fixture = loadFixture("caiman/sdk36/TEE_EC_RKP")
    const verifier = createAttestationVerifier({
        roots: GOOGLE_ATTESTATION_ROOTS,
        statusList: { snapshot: () => ({ serials: new Set(), fetchedAt: 0 }) },
        now: () => fixture.createdAt
    })
    assert.deepEqual(verifier.verify(fixture.chain, fixture.leafKeyXY), { ok: false, reason: "CHALLENGE_MISMATCH" })
})

test("the injected test root anchors nothing in production", async () => {
    const { chain } = await mintChain({ confirmationKeyXY: KEY_XY })
    const verifier = createAttestationVerifier({
        roots: GOOGLE_ATTESTATION_ROOTS,
        statusList: { snapshot: () => ({ serials: new Set(), fetchedAt: 0 }) }
    })
    assert.deepEqual(verifier.verify(chain, KEY_XY), { ok: false, reason: "UNTRUSTED_ROOT", certIndex: 4 })
})
