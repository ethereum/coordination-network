export type WalletErrorCode =
    | "NOT_FOUND"
    | "ALREADY_STORED"
    | "CREDENTIAL_INVALID"
    | "CONSENT_DENIED"
    | "REVOKED"
    | "CHAIN_STATE_UNAVAILABLE"
    | "CHAIN_STATE_INVALID"
    | "NOT_YET_VALID"
    | "EXPIRED"
    | "ISSUER_NOT_APPROVED"
    | "PRESENTATION_FAILED"

export class WalletError extends Error {
    readonly code: WalletErrorCode
    readonly cause?: unknown

    constructor(code: WalletErrorCode, message: string, cause?: unknown) {
        super(message)
        this.name = "WalletError"
        this.code = code
        this.cause = cause
    }
}
