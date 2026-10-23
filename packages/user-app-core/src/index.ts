/**
 * `@coordination-network/user-app-core` — the three `user-app-link` operations a user app serves,
 * over injected device, storage and proving ports. See `README.md`.
 */

export { createUserAppService } from "./service"
export { DeviceKeyError, mapWalletError } from "./errors"
export { latestExpiring, matchingCredentials, type CredentialSelectionRequest } from "./selection"
export { buildConsentSummary } from "./consent"
export { DEVICE_SECRET_KEY } from "./device-secret"
export { CREDENTIAL_ISSUE_STEPS } from "./steps"
export { listIssuerEntries, readIssuerEntry, type IssuerIndexEntry } from "./issuer-index"
export { DEVICE_ATTESTATION_CHALLENGE } from "@coordination-network/credential"
export type {
    ConsentDetail,
    ConsentScope,
    ConsentSummary,
    DeviceKey,
    ChainRoots,
    HeldCredential,
    HeldCredentialStatus,
    HttpClient,
    HttpJsonResponse,
    KeyPrompt,
    MemberDirectory,
    PresentationReview,
    PresentationReviewPrompt,
    PublicIdentity,
    RevocationAuthority,
    RootAuthority,
    StealthScanKeys,
    UserAppPorts,
    UserAppService,
    UserConsentPrompt
} from "./types"
