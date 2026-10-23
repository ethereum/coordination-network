package expo.modules.identitykeystore

import expo.modules.kotlin.exception.CodedException

/** No Android Keystore entry exists under the requested alias. */
internal class KeyNotFoundException(alias: String) :
  CodedException("No Keystore entry found for alias '$alias'")

/** `generateKey` failed (StrongBox + TEE both unavailable, or an underlying `KeyStore` error). */
internal class KeyGenerationException(message: String?, cause: Throwable? = null) :
  CodedException("Failed to generate Keystore key: ${message ?: "unknown error"}", cause)

/** `sign` failed (malformed input or an underlying `Signature`/`KeyStore` error). */
internal class SigningException(message: String?, cause: Throwable? = null) :
  CodedException("Failed to sign with Keystore key: ${message ?: "unknown error"}", cause)

/** `signDigest`'s digest is malformed: not valid base64, or not exactly 32 bytes. */
internal class InvalidDigestException(message: String?, cause: Throwable? = null) :
  CodedException("Invalid signDigest digest: ${message ?: "unknown error"}", cause)

/** `signDigest` on an alias created before `DIGEST_NONE` was authorized; digests are fixed at creation. */
internal class DigestNoneUnauthorizedException(alias: String) :
  CodedException(
    "Keystore alias '$alias' was created without DIGEST_NONE and can never signDigest; " +
      "regenerating it rotates the key and orphans anything bound to it"
  )

/** `ecdh` was called on a platform below API 31, where `PURPOSE_AGREE_KEY` doesn't exist. */
internal class EcdhUnsupportedException :
  CodedException("ECDH requires API 31+ (PURPOSE_AGREE_KEY is unavailable on this device)")

/** `ecdh`'s peer key is malformed: not valid base64, wrong length/prefix, or not on curve. */
internal class InvalidPeerKeyException(message: String?, cause: Throwable? = null) :
  CodedException("Invalid ECDH peer public key: ${message ?: "unknown error"}", cause)

/** `ecdh` failed (an underlying `KeyAgreement`/`KeyStore` error). */
internal class EcdhException(message: String?, cause: Throwable? = null) :
  CodedException("Failed to compute ECDH shared secret: ${message ?: "unknown error"}", cause)

/** `getSecurityLevel` failed to read `KeyInfo` for the alias. */
internal class SecurityLevelException(message: String?, cause: Throwable? = null) :
  CodedException("Failed to read Keystore security level: ${message ?: "unknown error"}", cause)

/** `getAttestationChain` failed to read or encode the certificate chain. */
internal class AttestationChainException(message: String?, cause: Throwable? = null) :
  CodedException("Failed to read Keystore attestation chain: ${message ?: "unknown error"}", cause)

/** `deleteKey`/`eraseAll` failed to remove an alias from the Keystore. */
internal class KeyDeletionException(message: String?, cause: Throwable? = null) :
  CodedException("Failed to delete Keystore key: ${message ?: "unknown error"}", cause)

// The five below pin their `code` rather than infer it from the class name: JS branches on these
// codes (`KEYSTORE_ERROR_CODES` in `src/native.ts`), and R8 may rename classes in a release build.

/** The user dismissed the authentication prompt, or the system canceled it. */
internal class UserCanceledException :
  CodedException("ERR_USER_CANCELED", "The user canceled authentication", null)

/** The key is unusable for good: the screen lock was removed or reset since it was generated. */
internal class KeyInvalidatedException(cause: Throwable) :
  CodedException("ERR_KEY_INVALIDATED", "The Keystore key was permanently invalidated", cause)

/** Every key requires user authentication, so `generateKey` needs a PIN, pattern or password set. */
internal class NoSecureLockScreenException :
  CodedException("ERR_NO_SECURE_LOCK_SCREEN", "A secure lock screen is required to generate a Keystore key", null)

/** Below API 31 there is no `PURPOSE_AGREE_KEY`, so `generateKey`, `sign` and `signDigest` refuse to run. */
internal class UnsupportedPlatformException :
  CodedException("ERR_UNSUPPORTED_PLATFORM", "User-authenticated Keystore keys require API 31+", null)

/** Lockout, a dialog error, no foreground activity, or another prompt already showing. */
internal class AuthenticationFailedException(message: String?, cause: Throwable? = null) :
  CodedException("ERR_AUTHENTICATION_FAILED", "Authentication failed: ${message ?: "unknown error"}", cause)
