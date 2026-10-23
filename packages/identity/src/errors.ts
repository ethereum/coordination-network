export type KeygenErrorCode =
    | "INVALID_DEVICE_SECRET"
    | "DERIVATION_FAILURE"
    | "INVALID_BINDING_INPUT"
    | "INVALID_ECDH_SECRET"
    | "INVALID_META_STEALTH_ADDRESS"
    | "INVALID_PUBLIC_KEY_LENGTH"

/**
 * Base error class for all errors thrown by this package, discriminated by
 * `code` so callers can branch without `instanceof` across bundle boundaries.
 */
export class KeygenError extends Error {
    readonly code: KeygenErrorCode

    constructor(code: KeygenErrorCode, message: string) {
        super(message)
        this.name = "KeygenError"
        this.code = code
    }
}

/** Thrown when a device secret does not satisfy the exactly-32-bytes contract. */
export class InvalidDeviceSecretError extends KeygenError {
    constructor(
        message: string = "Invalid device secret: expected a 32-byte Uint8Array or a 0x-prefixed 64-character hex string"
    ) {
        super("INVALID_DEVICE_SECRET", message)
        this.name = "InvalidDeviceSecretError"
    }
}

/** Thrown when key derivation fails for a reason unrelated to input shape. */
export class DerivationFailureError extends KeygenError {
    constructor(message: string = "Key derivation failed") {
        super("DERIVATION_FAILURE", message)
        this.name = "DerivationFailureError"
    }
}

/**
 * Thrown for malformed credential-binding inputs; a well-formed signature
 * that merely fails to verify returns `false` instead.
 */
export class InvalidBindingInputError extends KeygenError {
    constructor(message: string = "Invalid credential-binding input") {
        super("INVALID_BINDING_INPUT", message)
        this.name = "InvalidBindingInputError"
    }
}

/** Thrown when a meta-stealth address fails to decode (bad prefix, length, hex, or curve point). */
export class InvalidMetaStealthAddressError extends KeygenError {
    constructor(message: string = "Invalid meta-stealth address") {
        super("INVALID_META_STEALTH_ADDRESS", message)
        this.name = "InvalidMetaStealthAddressError"
    }
}

/** Thrown when a hardware ECDH shared secret does not satisfy the exactly-32-bytes contract. */
export class InvalidEcdhSecretError extends KeygenError {
    constructor(
        message: string = "Invalid ECDH shared secret: expected a 32-byte Uint8Array or a 0x-prefixed 64-character hex string"
    ) {
        super("INVALID_ECDH_SECRET", message)
        this.name = "InvalidEcdhSecretError"
    }
}

/** Thrown when a public key is not the correct length */
export class InvalidPublicKeyLengthError extends KeygenError {
    constructor(message: string = "Invalid public key length. Expected a 65-byte uncompressed SEC1 public key") {
        super("INVALID_PUBLIC_KEY_LENGTH", message)
        this.name = "InvalidPublicKeyLengthError"
    }
}
