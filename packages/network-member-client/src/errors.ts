export type NetworkMemberClientErrorCode =
    | "ISSUER_KEY_NOT_PUBLISHED"
    | "MEMBER_NOT_APPROVED"
    | "RECIPIENT_NOT_REGISTERED"
    | "INVALID_META_STEALTH_ADDRESS"
    | "INVALID_REGISTRATION_REQUEST"
    | "REGISTRY_UNAVAILABLE"
    | "GROUP_MIRROR_UNAVAILABLE"
    | "MEMBER_NOT_IN_GROUP"
    | "REGISTRATION_REJECTED"
    | "REVOCATION_REJECTED"

export class NetworkMemberClientError extends Error {
    readonly code: NetworkMemberClientErrorCode
    // `declare` emits no field: at ES2022 one would be created enumerable, defeating defineProperty.
    declare readonly cause?: unknown

    constructor(code: NetworkMemberClientErrorCode, message: string, cause?: unknown) {
        super(message)
        this.name = "NetworkMemberClientError"
        this.code = code
        if (cause !== undefined) {
            // Non-enumerable, matching the standard Error.cause: a provider error's circular
            // transport graph would otherwise make JSON.stringify throw in a caller's handler.
            Object.defineProperty(this, "cause", { value: cause, writable: true, configurable: true })
        }
    }
}

/** A named revert from IdentityRegistry or Semaphore, walked out of a viem contract-call error. */
export class RegistryRevertError extends NetworkMemberClientError {
    readonly errorName: string

    constructor(errorName: string, cause?: unknown) {
        super("REGISTRATION_REJECTED", errorName, cause)
        this.name = "RegistryRevertError"
        this.errorName = errorName
    }
}

/**
 * A revert from CredentialRevocationRegistry, or from the revocation service or Semaphore behind
 * it. `reason` is the decoded error name, or the raw revert data when nothing in the registry's
 * ABI matches it: a caller retries `InvalidLowLeaf` against a re-synced mirror and gives up on
 * `LeafAlreadyExists`, so it has to be able to tell them apart.
 */
export class RevocationRevertError extends NetworkMemberClientError {
    readonly reason: string

    constructor(reason: string, cause?: unknown) {
        super("REVOCATION_REJECTED", reason, cause)
        this.name = "RevocationRevertError"
        this.reason = reason
    }
}
