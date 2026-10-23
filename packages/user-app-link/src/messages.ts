import type { LinkErrorCode } from "./types"

/** The only error text that leaves the wallet, bar the zod text for malformed params; other detail stays on the device. */
export const LINK_ERROR_MESSAGES: Record<LinkErrorCode, string> = {
    USER_DENIED: "The person declined the request.",
    CONSENT_DENIED: "The person declined to share.",
    UNSUPPORTED_OP: "This wallet does not support that operation.",
    INVALID_REQUEST: "The request was not valid.",
    NOT_ONBOARDED: "The wallet has no identity yet.",
    NO_CREDENTIAL: "No matching credential.",
    CREDENTIAL_REVOKED: "The matching credential has been revoked.",
    PROOF_FAILED: "The wallet could not build the proof.",
    ISSUER_UNREACHABLE: "The wallet could not use the issuer's server.",
    VERIFIER_UNREACHABLE: "The wallet could not use the verifier's server.",
    ISSUER_NOT_APPROVED: "The credential's issuer key is not approved on chain.",
    CHAIN_UNREACHABLE: "The wallet could not read the chain.",
    INTERNAL: "The wallet failed."
}
