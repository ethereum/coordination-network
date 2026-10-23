export type MemberServerErrorCode =
    // apps/issuer-service's own documented codes.
    | "INVALID_PARAMS"
    | "ISSUER_NOT_APPROVED"
    | "SUBJECT_MISMATCH"
    | "BINDING_INVALID"
    | "HOLDER_KEY_OWNERSHIP_INVALID"
    | "COMMITMENT_OWNERSHIP_INVALID"
    | "INVALID_REGISTRATION_REQUEST"
    | "GROUP_MIRROR_UNAVAILABLE"
    | "REGISTRY_UNAVAILABLE"
    | "MEMBER_NOT_IN_GROUP"
    | "REGISTRATION_REJECTED"
    | "MEMBER_NOT_APPROVED"
    | "DELIVERY_REFUSED"
    | "ANNOUNCE_FAILED"
    | "NOT_CONFIGURED"
    | "UNAUTHORIZED"
    | "RATE_LIMITED"
    // This client's own fallbacks, for a response the server sent without one of the codes above.
    | "BAD_REQUEST"
    | "NOT_FOUND"
    | "INVALID_RESPONSE"
    | "REQUEST_FAILED"

/** A `MemberServerClient` failure, discriminated by the server's own error code where it sent one. */
export class MemberServerError extends Error {
    readonly code: MemberServerErrorCode
    readonly status?: number

    constructor(code: MemberServerErrorCode, message: string, status?: number) {
        super(message)
        this.name = "MemberServerError"
        this.code = code
        this.status = status
    }
}
