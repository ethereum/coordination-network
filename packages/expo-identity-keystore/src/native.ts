/**
 * TS surface for the Android-only `IdentityKeystore` Expo Module: hardware-backed
 * P-256 keys, each generated for one purpose. A `sign` key is the credential's
 * `confirmationKey`; an `agree` key does ECDH for the hardware-rooted EdDSA key.
 * Every use of either key needs the user present (biometric or device credential).
 */

/** Where in the platform's key hierarchy a Keystore-generated key lives. */
export type KeystoreSecurityLevel = "STRONGBOX" | "TRUSTED_ENVIRONMENT" | "SOFTWARE" | "UNKNOWN"

/**
 * `sign`: `sign`/`signDigest` only, with a prompt on every use.
 * `agree`: `ecdh` only, with a prompt when the last unlock is over 10 s old.
 */
export type KeyPurpose = "sign" | "agree"

export interface GenerateKeyOptions {
    purpose: KeyPurpose
    /**
     * Base64, at most 128 bytes. Makes the platform attest the key to its hardware root of
     * trust; read the result with `getAttestationChain`. Native generation fails rather than
     * produce an unattested key.
     */
    attestationChallenge?: string
}

export interface GeneratedKey {
    /** Base64 SEC1 uncompressed public key. */
    publicKey: string
    securityLevel: KeystoreSecurityLevel
}

/** Text of the system authentication dialog. */
export interface AuthPrompt {
    title: string
    subtitle?: string
}

/** The `code` a native rejection carries for the failures a caller is expected to handle. */
export const KEYSTORE_ERROR_CODES = {
    userCanceled: "ERR_USER_CANCELED",
    /** The screen lock was removed or reset; the key is unusable for good. */
    keyInvalidated: "ERR_KEY_INVALIDATED",
    noSecureLockScreen: "ERR_NO_SECURE_LOCK_SCREEN",
    unsupportedPlatform: "ERR_UNSUPPORTED_PLATFORM",
    /** Lockout, a dialog error, no foreground activity, or another prompt already showing. */
    authenticationFailed: "ERR_AUTHENTICATION_FAILED"
} as const

export type KeystoreErrorCode = (typeof KEYSTORE_ERROR_CODES)[keyof typeof KEYSTORE_ERROR_CODES]

/** Reads the keystore code off a native rejection; `null` for any other error or value. */
export function keystoreErrorCode(error: unknown): KeystoreErrorCode | null {
    if (typeof error !== "object" || error === null || !("code" in error)) {
        return null
    }

    return Object.values(KEYSTORE_ERROR_CODES).find((code) => code === error.code) ?? null
}

/** Typed surface of the native module. All key material crosses the bridge as base64. */
export interface Keystore {
    /**
     * Generates a P-256 keypair for `options.purpose` under `alias` (StrongBox where
     * available, else TEE). Replaces an existing key at `alias` — read with
     * `hasKey`/`getPublicKey` instead. Rejects with `ERR_NO_SECURE_LOCK_SCREEN`
     * without a screen lock, and `ERR_UNSUPPORTED_PLATFORM` below Android 12.
     */
    generateKey(alias: string, options: GenerateKeyOptions): Promise<GeneratedKey>
    /** Reports whether `alias` exists in the platform Keystore. */
    hasKey(alias: string): Promise<boolean>
    /**
     * Reads `alias`'s existing public key, without generating or rotating it;
     * resolves the base64 SEC1 uncompressed public key. Rejects if `alias`
     * doesn't exist.
     */
    getPublicKey(alias: string): Promise<string>
    /**
     * Signs `messageBase64` with `alias`'s `sign` key after showing `prompt`;
     * resolves a base64 DER ECDSA signature.
     */
    sign(alias: string, messageBase64: string, prompt: AuthPrompt): Promise<string>
    /**
     * Signs `digestBase64` (exactly 32 raw bytes, not hashed again) with `alias`'s
     * `sign` key after showing `prompt`; resolves a base64 DER ECDSA signature.
     */
    signDigest(alias: string, digestBase64: string, prompt: AuthPrompt): Promise<string>
    /**
     * Computes the ECDH shared secret between `alias`'s `agree` key and
     * `peerPublicKeyBase64` (base64 SEC1 uncompressed point), showing `prompt` only
     * when the key's 10 s unlock window has lapsed; resolves the base64 32-byte
     * big-endian X coordinate.
     */
    ecdh(alias: string, peerPublicKeyBase64: string, prompt: AuthPrompt): Promise<string>
    /** Reports where `alias`'s key actually lives in the platform's key hierarchy. */
    getSecurityLevel(alias: string): Promise<KeystoreSecurityLevel>
    /**
     * Resolves the base64 DER certificate chain attesting `alias`'s key, leaf first; empty
     * when the key was generated without a challenge or the chain has fewer than two
     * certificates (the platform can't attest, or returned a lone self-signed one).
     */
    getAttestationChain(alias: string): Promise<string[]>
    /** Deletes `alias` from the platform Keystore. */
    deleteKey(alias: string): Promise<void>
    /** Deletes every alias in the platform Keystore; resolves the number deleted. */
    eraseAll(): Promise<number>
}

/**
 * Loads the native module, or `null` where it can't (Expo Go, iOS, jest) so
 * callers can render an unavailable state. `expo-modules-core` is required
 * lazily: a top-level import breaks ts-jest, which loads this file under Node.
 */
export function getKeystore(): Keystore | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { requireNativeModule } = require("expo-modules-core")
        return requireNativeModule("IdentityKeystore")
    } catch {
        return null
    }
}
