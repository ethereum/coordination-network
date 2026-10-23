/**
 * Derives the URLs the user app needs from a member's own `serverUrl`, so no app hardcodes an
 * issuer-service path. `serverUrl` carries no trailing slash - `createMemberServerClient` appends
 * a leading-slash path directly, and these do the same.
 */
export function challengeUrl(serverUrl: string): string {
    return `${serverUrl}/v1/challenge`
}

export function credentialsUrl(serverUrl: string): string {
    return `${serverUrl}/v1/credentials`
}

export function issuersUrl(serverUrl: string): string {
    return `${serverUrl}/v1/issuers`
}

export function revocationsUrl(serverUrl: string): string {
    return `${serverUrl}/v1/revocations/snapshot`
}

export function responseUrl(serverUrl: string): string {
    return `${serverUrl}/v1/verify`
}
