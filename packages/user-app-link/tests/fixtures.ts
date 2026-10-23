import type {
    Caller,
    CredentialIssueParams,
    CredentialIssueResult,
    PresentationCreateParams,
    PresentationCreateResult,
    RegistrationSignParams,
    RegistrationSignResult
} from "../src/types"

function hex(byteLength: number, byte: string): `0x${string}` {
    return `0x${byte.repeat(byteLength)}` as `0x${string}`
}

export const caller: Caller = { name: "Member App", scheme: "memberapp" }
export const callback = "memberapp://v1/response"

export const registrationSignParams: RegistrationSignParams = {
    chainId: 1,
    verifyingContract: hex(20, "44")
}

export const registrationSignResult: RegistrationSignResult = {
    request: {
        version: "v1",
        networkId: hex(32, "11"),
        schemeId: 1,
        metaStealthAddress: hex(66, "22"),
        chainId: 1,
        verifyingContract: hex(20, "44"),
        signature: hex(65, "55")
    },
    securityLevel: "SOFTWARE"
}

export const credentialIssueParams: CredentialIssueParams = {
    issuerNetworkId: hex(32, "77"),
    approvalScope: { programme: "demo-programme", country: "ZZZ" },
    challengeUrl: "https://issuer.example/v1/challenge",
    credentialsUrl: "https://issuer.example/v1/credentials",
    issuersUrl: "https://issuer.example/v1/issuers",
    revocationsUrl: "https://issuer.example/v1/revocations/snapshot"
}

export const credentialIssueResult: CredentialIssueResult = { status: "stored", credentialId: "cred-1" }

export const presentationCreateParams: PresentationCreateParams = {
    requestId: "presentation-request-1",
    challenge: hex(31, "99"),
    audience: "urn:cn:network:member-server",
    currentTime: 1_700_000_000,
    programme: "demo-programme",
    country: "ZZZ",
    issuersUrl: "https://member.example/v1/issuers",
    revocationsUrl: "https://member.example/v1/revocations/snapshot",
    responseUrl: "https://member.example/v1/verify"
}

export const presentationCreateResult: PresentationCreateResult = { verificationId: "verification-1" }
