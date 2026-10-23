import assert from "node:assert/strict"
import { test } from "node:test"
import { credentialsBody, hexBytes } from "../src/schemas"

function assertParsed(result: { success: boolean; error?: unknown }): void {
    if (!result.success) assert.fail(JSON.stringify(result.error))
}

test("hexBytes accepts both 0x-prefixed and bare hex", () => {
    assert.deepEqual(hexBytes.parse("0xdead"), Uint8Array.from([0xde, 0xad]))
    assert.deepEqual(hexBytes.parse("0Xdead"), Uint8Array.from([0xde, 0xad]))
    assert.deepEqual(hexBytes.parse("dead"), Uint8Array.from([0xde, 0xad]))
})

test("hexBytes rejects odd-length hex as a parse failure instead of throwing", () => {
    assert.equal(hexBytes.safeParse("0xabc").success, false)
    assert.equal(hexBytes.safeParse("abc").success, false)
})

test("POST /v1/credentials body schema accepts 0x-prefixed hex fields", () => {
    // Every other package in this repo emits 0x-prefixed hex, so a member app forwarding
    // accountPublicKey/devicePopSignature/accountPopSignature straight from the user app's own
    // output must not be rejected for the prefix alone. Values are placeholders: this checks
    // schema acceptance, not signature validity, which issueZkCredential checks separately.
    const body = {
        challengeId: "123e4567-e89b-42d3-a456-426614174000",
        subjectNetworkId: `0x${"11".repeat(32)}`,
        approvalScope: { programme: "demo-programme", country: "ZZZ" },
        confirmationKey: { kty: "EC", crv: "P-256", x: "eA", y: "eQ" },
        accountPublicKey: `0x${"02".repeat(33)}`,
        devicePopSignature: `0x${"03".repeat(64)}`,
        accountPopSignature: `0x${"04".repeat(65)}`,
        identityPublicKey: ["1", "2"],
        identityOwnershipSignature: { R8: ["9", "10"], S: "11" },
        revocation: {
            commitment: "3",
            publicKey: ["4", "5"],
            ownershipSignature: { R8: ["6", "7"], S: "8" }
        }
    }

    const result = credentialsBody.safeParse(body)
    assertParsed(result)
})

const ISSUE_BODY = {
    challengeId: "123e4567-e89b-42d3-a456-426614174000",
    subjectNetworkId: `0x${"11".repeat(32)}`,
    approvalScope: { programme: "demo-programme", country: "ZZZ" },
    confirmationKey: { kty: "EC", crv: "P-256", x: "eA", y: "eQ" },
    accountPublicKey: "02",
    devicePopSignature: "03",
    accountPopSignature: "04",
    identityPublicKey: ["1", "2"],
    identityOwnershipSignature: { R8: ["9", "10"], S: "11" },
    revocation: { commitment: "3", publicKey: ["4", "5"], ownershipSignature: { R8: ["6", "7"], S: "8" } }
}

test("deviceAttestation is optional, and up to ten strict base64 certificates", () => {
    assertParsed(credentialsBody.safeParse(ISSUE_BODY))
    const parsed = credentialsBody.safeParse({ ...ISSUE_BODY, deviceAttestation: ["QUJD", "QQ=="] })
    assertParsed(parsed)
    assert.deepEqual(parsed.data?.deviceAttestation, ["QUJD", "QQ=="])
    assertParsed(credentialsBody.safeParse({ ...ISSUE_BODY, deviceAttestation: Array(10).fill("QUJD") }))

    for (const bad of [Array(11).fill("QUJD"), [""], ["QQ"], ["QU JD"], ["QUJD\n"], ["Q-_D"], "QUJD", [1]]) {
        assert.equal(
            credentialsBody.safeParse({ ...ISSUE_BODY, deviceAttestation: bad }).success,
            false,
            JSON.stringify(bad)
        )
    }
})

test("an old client's deviceSecurityLevel is dropped, not rejected", () => {
    const parsed = credentialsBody.safeParse({ ...ISSUE_BODY, deviceSecurityLevel: "STRONGBOX" })
    assertParsed(parsed)
    assert.ok(!("deviceSecurityLevel" in (parsed.data ?? {})))
})
