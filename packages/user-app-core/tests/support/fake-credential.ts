import { countryCode, programmeHash } from "@coordination-network/credential"
import type { SerializedZkCredential } from "@coordination-network/credential"
import type { CredentialInfo, CredentialStatus } from "@coordination-network/wallet"

/**
 * A structurally-valid (but unsigned) `SerializedZkCredential`, for tests that exercise
 * `parseZkCredential`'s shape without needing a real issuer signature — {@link matchingCredentials}
 * never checks the signature, only the body.
 */
export function fakeSerializedCredential(
    overrides: Partial<{ programme: string; country: string; notBefore: number; expiresAt: number }> = {}
): SerializedZkCredential {
    const programme = overrides.programme ?? "demo-programme"
    const country = overrides.country ?? "ZZZ"
    return {
        body: {
            programmeHash: programmeHash(programme).toString(),
            countryCode: countryCode(country),
            notBefore: overrides.notBefore ?? 0,
            expiresAt: overrides.expiresAt ?? 1_000_000,
            deviceKeyCommitment: "1",
            holderKeyCommitment: "1",
            revocationCommitment: "1"
        },
        issuerPublicKey: ["1", "2"],
        signature: { R8: ["1", "2"], S: "1" }
    }
}

export function fakeCredentialInfo(
    id: string,
    status: CredentialStatus,
    overrides: Parameters<typeof fakeSerializedCredential>[0] = {}
): CredentialInfo {
    return { id, status, checkedAt: 0, credential: fakeSerializedCredential(overrides) }
}
