export type AttestedLevel = "TRUSTED_ENVIRONMENT" | "STRONGBOX"

/** What the chain itself claims. Factory chains below StrongBox claim nothing. */
export type ChainSecurityLevel = "SOFTWARE" | AttestedLevel

export type ChainFailure =
    | "CHAIN_SIZE"
    | "CERT_MALFORMED"
    | "UNTRUSTED_ROOT"
    | "UNKNOWN_PROVISIONING"
    | "PROVISIONING_MISMATCH"
    | "NAME_CHAINING"
    | "INVALID_SIGNATURE"
    | "CERT_NOT_YET_VALID"
    | "CERT_EXPIRED"
    | "CERT_REVOKED"
    | "EXTENSION_MISSING"
    | "EXTENSION_MISPLACED"
    | "LEAF_KEY_MISMATCH"
    | "KEY_DESCRIPTION_MALFORMED"

export type PolicyFailure =
    | "CHALLENGE_MISMATCH"
    | "SECURITY_LEVEL_MISMATCH"
    | "SOFTWARE_LEVEL"
    | "NO_AUTH_REQUIRED"
    | "AUTH_TIMEOUT"
    | "ALLOW_WHILE_ON_BODY"
    | "USER_AUTH_TYPE"
    | "KEY_ALGORITHM"
    | "KEY_PURPOSE"
    | "KEY_DIGEST"
    | "KEY_ORIGIN"
    | "ROOT_OF_TRUST_MISSING"
    | "BOOT_NOT_VERIFIED"
    | "DEVICE_UNLOCKED"

/** Logged as-is, with at most a cert index: none of these names the device. */
export type AttestationFailure = "STATUS_LIST_UNAVAILABLE" | "MALFORMED_CHAIN" | ChainFailure | PolicyFailure

export type AttestationResult =
    { ok: true; level: AttestedLevel } | { ok: false; reason: AttestationFailure; certIndex?: number }
