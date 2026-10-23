export type IssuanceErrorCode =
    | "INVALID_PARAMS"
    | "ISSUER_NOT_APPROVED"
    | "SUBJECT_MISMATCH"
    | "BINDING_INVALID"
    | "HOLDER_KEY_OWNERSHIP_INVALID"
    | "COMMITMENT_OWNERSHIP_INVALID"

export class IssuanceError extends Error {
    readonly code: IssuanceErrorCode

    constructor(code: IssuanceErrorCode, message: string) {
        super(message)
        this.name = "IssuanceError"
        this.code = code
    }
}
