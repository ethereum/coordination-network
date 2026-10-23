import assert from "node:assert/strict"
import { test } from "node:test"
import { GOOGLE_ATTESTATION_ROOTS } from "../src/attestation"
import type { AuthorizationTags, KeyDescriptionInfo } from "../src/attestation/parse"
import { checkPolicy } from "../src/attestation/policy"
import { verifyChain } from "../src/attestation/verify-chain"
import { CHALLENGE, TRUSTED_FIXTURES, loadFixture } from "./attestation-fixtures"

const NO_TAGS: AuthorizationTags = { noAuthRequired: false, allowWhileOnBody: false }

/** A per-use, user-authenticated TEE key on a locked, verified device. */
function perUseKey(
    hardware: Partial<AuthorizationTags> = {},
    overrides: Partial<KeyDescriptionInfo> = {}
): KeyDescriptionInfo {
    return {
        attestationVersion: 300,
        attestationSecurityLevel: 1,
        keyMintVersion: 300,
        keyMintSecurityLevel: 1,
        attestationChallenge: CHALLENGE,
        softwareEnforced: NO_TAGS,
        hardwareEnforced: {
            purpose: [2],
            algorithm: 3,
            keySize: 256,
            digest: [4],
            ecCurve: 1,
            noAuthRequired: false,
            userAuthType: 3,
            allowWhileOnBody: false,
            origin: 0,
            rootOfTrust: { deviceLocked: true, verifiedBootState: 0 },
            ...hardware
        },
        ...overrides
    }
}

test("accepts a per-use TEE key and returns its attested level", () => {
    assert.deepEqual(checkPolicy(perUseKey(), undefined), { ok: true, level: "TRUSTED_ENVIRONMENT" })
    assert.deepEqual(checkPolicy(perUseKey(), "TRUSTED_ENVIRONMENT"), { ok: true, level: "TRUSTED_ENVIRONMENT" })
})

test("accepts a StrongBox key only from a chain that says StrongBox", () => {
    const strongBox = perUseKey({}, { attestationSecurityLevel: 2, keyMintSecurityLevel: 2 })
    assert.deepEqual(checkPolicy(strongBox, "STRONGBOX"), { ok: true, level: "STRONGBOX" })
    for (const chainLevel of [undefined, "TRUSTED_ENVIRONMENT", "SOFTWARE"] as const) {
        assert.deepEqual(checkPolicy(strongBox, chainLevel), { ok: false, reason: "SECURITY_LEVEL_MISMATCH" })
    }
})

test("refuses a TEE key from a chain that claims another level", () => {
    for (const chainLevel of ["STRONGBOX", "SOFTWARE"] as const) {
        assert.deepEqual(checkPolicy(perUseKey(), chainLevel), { ok: false, reason: "SECURITY_LEVEL_MISMATCH" })
    }
})

const REFUSALS: [string, KeyDescriptionInfo, string][] = [
    [
        "a different challenge",
        perUseKey({}, { attestationChallenge: CHALLENGE.map((b) => b ^ 1) }),
        "CHALLENGE_MISMATCH"
    ],
    ["a truncated challenge", perUseKey({}, { attestationChallenge: CHALLENGE.subarray(1) }), "CHALLENGE_MISMATCH"],
    ["differing attestation and KeyMint levels", perUseKey({}, { keyMintSecurityLevel: 2 }), "SECURITY_LEVEL_MISMATCH"],
    ["a software key", perUseKey({}, { attestationSecurityLevel: 0, keyMintSecurityLevel: 0 }), "SOFTWARE_LEVEL"],
    ["noAuthRequired", perUseKey({ noAuthRequired: true }), "NO_AUTH_REQUIRED"],
    [
        "noAuthRequired in the software list",
        perUseKey({}, { softwareEnforced: { ...NO_TAGS, noAuthRequired: true } }),
        "NO_AUTH_REQUIRED"
    ],
    ["an auth timeout", perUseKey({ authTimeout: 10 }), "AUTH_TIMEOUT"],
    ["an auth timeout of zero", perUseKey({ authTimeout: 0 }), "AUTH_TIMEOUT"],
    [
        "an auth timeout in the software list",
        perUseKey({}, { softwareEnforced: { ...NO_TAGS, authTimeout: 0 } }),
        "AUTH_TIMEOUT"
    ],
    ["allowWhileOnBody", perUseKey({ allowWhileOnBody: true }), "ALLOW_WHILE_ON_BODY"],
    ["no user auth type", perUseKey({ userAuthType: undefined }), "USER_AUTH_TYPE"],
    ["fingerprint only", perUseKey({ userAuthType: 2 }), "USER_AUTH_TYPE"],
    ["password only", perUseKey({ userAuthType: 1 }), "USER_AUTH_TYPE"],
    ["an RSA key", perUseKey({ algorithm: 1 }), "KEY_ALGORITHM"],
    ["a P-384 key", perUseKey({ ecCurve: 2, keySize: 384 }), "KEY_ALGORITHM"],
    ["a key size other than 256", perUseKey({ keySize: 384 }), "KEY_ALGORITHM"],
    ["no algorithm", perUseKey({ algorithm: undefined }), "KEY_ALGORITHM"],
    ["no SIGN purpose", perUseKey({ purpose: [3] }), "KEY_PURPOSE"],
    ["an AGREE_KEY purpose", perUseKey({ purpose: [2, 6] }), "KEY_PURPOSE"],
    ["no purpose", perUseKey({ purpose: undefined }), "KEY_PURPOSE"],
    ["no SHA-256 digest", perUseKey({ digest: [5] }), "KEY_DIGEST"],
    ["no digest", perUseKey({ digest: undefined }), "KEY_DIGEST"],
    ["an imported key", perUseKey({ origin: 2 }), "KEY_ORIGIN"],
    ["no origin", perUseKey({ origin: undefined }), "KEY_ORIGIN"],
    ["no root of trust", perUseKey({ rootOfTrust: undefined }), "ROOT_OF_TRUST_MISSING"],
    [
        "a SelfSigned boot",
        perUseKey({ rootOfTrust: { deviceLocked: true, verifiedBootState: 1 } }),
        "BOOT_NOT_VERIFIED"
    ],
    [
        "an Unverified boot",
        perUseKey({ rootOfTrust: { deviceLocked: false, verifiedBootState: 2 } }),
        "BOOT_NOT_VERIFIED"
    ],
    [
        "an unlocked bootloader",
        perUseKey({ rootOfTrust: { deviceLocked: false, verifiedBootState: 0 } }),
        "DEVICE_UNLOCKED"
    ]
]

for (const [name, description, reason] of REFUSALS) {
    test(`refuses ${name}`, () => {
        assert.deepEqual(checkPolicy(description, undefined), { ok: false, reason })
    })
}

test("reads requirements from the hardware list only", () => {
    const { hardwareEnforced } = perUseKey()
    const softwareOnly = perUseKey(
        { userAuthType: undefined, rootOfTrust: undefined },
        { softwareEnforced: { ...hardwareEnforced } }
    )
    assert.deepEqual(checkPolicy(softwareOnly, undefined), { ok: false, reason: "USER_AUTH_TYPE" })
    assert.deepEqual(
        checkPolicy(
            { ...softwareOnly, hardwareEnforced: { ...softwareOnly.hardwareEnforced, userAuthType: 3 } },
            undefined
        ),
        {
            ok: false,
            reason: "ROOT_OF_TRUST_MISSING"
        }
    )
})

// Google's test keys are all noAuthRequired. Checked against each one's own challenge, that is
// the first thing this policy refuses them for.
for (const name of TRUSTED_FIXTURES) {
    test(`refuses ${name} for not requiring user auth`, () => {
        const fixture = loadFixture(name)
        const chain = verifyChain({
            chain: fixture.chain,
            roots: GOOGLE_ATTESTATION_ROOTS,
            revokedSerials: new Set(),
            now: fixture.createdAt,
            confirmationKeyXY: fixture.leafKeyXY
        })
        assert.ok(chain.ok)
        assert.deepEqual(checkPolicy(chain.description, chain.securityLevel, fixture.challenge), {
            ok: false,
            reason: "NO_AUTH_REQUIRED"
        })
    })
}
