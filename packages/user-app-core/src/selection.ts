import { countryCode, parseZkCredential, programmeHash } from "@coordination-network/credential"
import type { CredentialInfo } from "@coordination-network/wallet"

export interface CredentialSelectionRequest {
    programme: string
    country: string
}

/**
 * `presentation.create` carries no credential id, so this narrows by what the credential body
 * says: the requested programme and country. Status is deliberately not a filter — each candidate
 * is then synced against the verifier's lists, checked against the chain's roots, and a caller
 * that finds none valid still needs to know whether it held a revoked one.
 */
export function matchingCredentials<T extends CredentialInfo>(
    credentials: T[],
    request: CredentialSelectionRequest
): T[] {
    const wantedProgramme = programmeHash(request.programme)
    const wantedCountry = countryCode(request.country)

    return credentials.filter((info) => {
        const { body } = parseZkCredential(info.credential)
        return body.programmeHash === wantedProgramme && body.countryCode === wantedCountry
    })
}

/** Of the credentials still usable, the one that stays usable longest, tie-broken by id for determinism. */
export function latestExpiring<T extends CredentialInfo>(credentials: T[]): T | null {
    if (credentials.length === 0) return null

    return credentials.reduce((best, candidate) => {
        const bestExpiry = parseZkCredential(best.credential).body.expiresAt
        const candidateExpiry = parseZkCredential(candidate.credential).body.expiresAt
        if (candidateExpiry !== bestExpiry) return candidateExpiry > bestExpiry ? candidate : best
        return candidate.id < best.id ? candidate : best
    })
}
