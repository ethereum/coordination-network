export type UserClientErrorCode = "INVALID_INPUT" | "SUBMISSION_FAILED" | "REGISTRY_READ_FAILED"

/** Base error class for all errors thrown by this package, discriminated by `code`. */
export class UserClientError extends Error {
    readonly code: UserClientErrorCode
    constructor(code: UserClientErrorCode, message: string) {
        super(message)
        this.name = "UserClientError"
        this.code = code
    }
}

export class SubmissionFailedError extends UserClientError {
    // `declare` emits no field: at ES2022 one would be created enumerable, defeating defineProperty.
    declare readonly cause?: unknown

    constructor(message: string, cause?: unknown) {
        super("SUBMISSION_FAILED", message)
        this.name = "SubmissionFailedError"
        if (cause !== undefined) {
            // Non-enumerable, matching the standard Error.cause. Provider errors hold circular
            // transport graphs, so an enumerable copy makes JSON.stringify throw inside a
            // caller's error handler and drags the provider's URL into its logs.
            Object.defineProperty(this, "cause", { value: cause, writable: true, configurable: true })
        }
    }
}

export class RegistryReadFailedError extends UserClientError {
    // See SubmissionFailedError's constructor for why cause is declared and non-enumerable.
    declare readonly cause?: unknown

    constructor(message: string, cause?: unknown) {
        super("REGISTRY_READ_FAILED", message)
        this.name = "RegistryReadFailedError"
        if (cause !== undefined) {
            Object.defineProperty(this, "cause", { value: cause, writable: true, configurable: true })
        }
    }
}
