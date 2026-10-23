package expo.modules.identitykeystore

import android.app.KeyguardManager
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricPrompt
import android.os.Build
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import android.util.Log
import androidx.annotation.RequiresApi
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.exception.toCodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.launch
import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.PublicKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.KeyAgreement

private const val ANDROID_KEYSTORE_PROVIDER = "AndroidKeyStore"
private const val EC_CURVE_NAME = "secp256r1"
private const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
private const val DIGEST_SIGNATURE_ALGORITHM = "NONEwithECDSA"
private const val TAG = "IdentityKeystoreModule"

/** Byte length of each raw P-256 affine coordinate (`X`, `Y`). */
private const val EC_COORDINATE_LENGTH = 32

/** Byte length `signDigest` requires of its input: a SHA-256 digest, unhashed again. */
private const val DIGEST_LENGTH = 32

/** The longest attestation challenge Keystore accepts. */
private const val MAX_ATTESTATION_CHALLENGE_LENGTH = 128

/** 0 makes every use of a signing key need its own prompt, bound to that one operation. */
private const val SIGN_KEY_AUTH_TIMEOUT_SECONDS = 0

/** Per-use auth can't cover `KeyAgreement` below Android 16 QPR2, so the agreement key gets a window. */
private const val AGREE_KEY_AUTH_TIMEOUT_SECONDS = 10

// The key spec and the prompt name the same two authenticators with different constants.
@RequiresApi(Build.VERSION_CODES.R)
private const val KEY_AUTHENTICATORS = KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL

@RequiresApi(Build.VERSION_CODES.R)
private const val PROMPT_AUTHENTICATORS =
  BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL

/**
 * Android Keystore backend for the user app's device keys and the `binding-keystore`,
 * `eddsa-keystore`, and `sign-digest` test cases: hardware-backed (StrongBox, else TEE)
 * P-256 keys, each generated for one purpose. A signing key is the dual-PoP
 * `confirmationKey` and needs the user for every `sign`/`signDigest`; an agreement key
 * roots the hardware-rooted EdDSA key through ECDH. All functions run off the JS thread
 * (`AsyncFunction` default); only the authentication prompt runs on the main thread.
 */
class IdentityKeystoreModule : Module() {
  // Async function bodies run one at a time on the modules queue, so the check-and-set
  // in [authenticate] can't interleave; the prompt callbacks clear it from the main thread.
  @Volatile
  private var promptInFlight = false

  override fun definition() = ModuleDefinition {
    Name("IdentityKeystore")

    AsyncFunction("generateKey") { alias: String, options: GenerateKeyOptions ->
      generateKeyImpl(alias, options.purpose, options.attestationChallenge)
    }

    AsyncFunction("hasKey") { alias: String ->
      hasKeyImpl(alias)
    }

    AsyncFunction("getPublicKey") { alias: String ->
      getPublicKeyImpl(alias)
    }

    AsyncFunction("sign") { alias: String, messageBase64: String, prompt: PromptOptions, promise: Promise ->
      signImpl(alias, messageBase64, prompt, promise)
    }

    AsyncFunction("signDigest") { alias: String, digestBase64: String, prompt: PromptOptions, promise: Promise ->
      signDigestImpl(alias, digestBase64, prompt, promise)
    }

    AsyncFunction("ecdh") { alias: String, peerPublicKeyBase64: String, prompt: PromptOptions, promise: Promise ->
      ecdhImpl(alias, peerPublicKeyBase64, prompt, promise)
    }

    AsyncFunction("getSecurityLevel") { alias: String ->
      getSecurityLevelImpl(alias)
    }

    AsyncFunction("getAttestationChain") { alias: String ->
      getAttestationChainImpl(alias)
    }

    AsyncFunction("deleteKey") { alias: String ->
      deleteKeyImpl(alias)
    }

    AsyncFunction("eraseAll") {
      eraseAllImpl()
    }
  }

  /**
   * Generates a P-256 keypair for `purpose` under `alias`, preferring StrongBox and falling
   * back to TEE/software whenever the StrongBox attempt fails — not just on
   * `StrongBoxUnavailableException`, since a StrongBox unit can reject `AGREE_KEY` (no KeyMint
   * agreement support), `DIGEST_NONE` (restricted algorithm set) or the auth policy with
   * other exceptions. The returned `securityLevel` reports where the alias actually landed.
   *
   * Refuses below API 31 ([UnsupportedPlatformException]) and without a secure lock screen
   * ([NoSecureLockScreenException]), since every key requires user authentication.
   *
   * Replaces `alias`'s key if one already exists: `KeyPairGenerator.generateKeyPair`
   * silently overwrites. Callers that want an existing key must check [hasKeyImpl]
   * and read it with [getPublicKeyImpl] — never call this to "read" a key.
   *
   * Keystore keys can't gain purposes, digests or an auth policy after creation: an alias
   * generated by an older build of this module must be deleted (`deleteKey`) and regenerated.
   *
   * With `attestationChallengeBase64` both the StrongBox attempt and the TEE retry request
   * attestation, so a key that comes back was attested, or generation failed.
   *
   * @return `publicKey` (base64 SEC1 uncompressed, `0x04 || X(32) || Y(32)`) and
   *   `securityLevel` (as [getSecurityLevelImpl])
   */
  private fun generateKeyImpl(
    alias: String,
    purpose: KeyPurpose,
    attestationChallengeBase64: String?
  ): Map<String, String> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      throw UnsupportedPlatformException()
    }

    val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
    if (!context.getSystemService(KeyguardManager::class.java).isDeviceSecure) {
      throw NoSecureLockScreenException()
    }

    val attestationChallenge = attestationChallengeBase64?.let(::decodeAttestationChallenge)

    val publicKey = try {
      generateKeyPair(alias, purpose, attestationChallenge, strongBoxBacked = true)
    } catch (e: KeyGenerationException) {
      throw e
    } catch (e: Exception) {
      Log.w(TAG, "StrongBox key generation failed, retrying in TEE", e)

      try {
        generateKeyPair(alias, purpose, attestationChallenge, strongBoxBacked = false)
      } catch (fallbackError: Exception) {
        fallbackError.addSuppressed(e)
        throw KeyGenerationException(fallbackError.message, fallbackError)
      }
    }

    return mapOf(
      "publicKey" to Base64.encodeToString(sec1UncompressedBytes(publicKey), Base64.NO_WRAP),
      "securityLevel" to getSecurityLevelImpl(alias)
    )
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun generateKeyPair(
    alias: String,
    purpose: KeyPurpose,
    attestationChallenge: ByteArray?,
    strongBoxBacked: Boolean
  ): ECPublicKey {
    val builder = when (purpose) {
      // `signDigest` signs with `NONEwithECDSA`, which the provider rejects against a key
      // authorized only for SHA-256; digests are fixed at creation, like purposes.
      KeyPurpose.SIGN -> KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
        .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_NONE)
        .setUserAuthenticationParameters(SIGN_KEY_AUTH_TIMEOUT_SECONDS, KEY_AUTHENTICATORS)
      KeyPurpose.AGREE -> KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_AGREE_KEY)
        .setUserAuthenticationParameters(AGREE_KEY_AUTH_TIMEOUT_SECONDS, KEY_AUTHENTICATORS)
    }

    // No `setInvalidatedByBiometricEnrollment`: Android ignores it once the device credential is
    // allowed, so a new fingerprint keeps the key and only a removed or reset screen lock kills it.
    builder
      .setAlgorithmParameterSpec(ECGenParameterSpec(EC_CURVE_NAME))
      .setUserAuthenticationRequired(true)
      .setIsStrongBoxBacked(strongBoxBacked)

    attestationChallenge?.let { builder.setAttestationChallenge(it) }

    val keyPairGenerator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE_PROVIDER)
    keyPairGenerator.initialize(builder.build())

    return keyPairGenerator.generateKeyPair().public as? ECPublicKey
      ?: throw KeyGenerationException("generated public key is not an ECPublicKey")
  }

  private fun decodeAttestationChallenge(challengeBase64: String): ByteArray {
    val challenge = try {
      Base64.decode(challengeBase64, Base64.NO_WRAP)
    } catch (e: Exception) {
      throw KeyGenerationException("attestationChallenge is not valid base64", e)
    }

    if (challenge.size > MAX_ATTESTATION_CHALLENGE_LENGTH) {
      throw KeyGenerationException(
        "attestationChallenge is ${challenge.size} bytes, over the $MAX_ATTESTATION_CHALLENGE_LENGTH-byte limit"
      )
    }

    return challenge
  }

  /** Reports whether `alias` exists in the platform Keystore. */
  private fun hasKeyImpl(alias: String): Boolean {
    return loadKeyStore().containsAlias(alias)
  }

  /**
   * Reads `alias`'s existing public key, without generating or rotating it —
   * the read-only counterpart to [generateKeyImpl].
   *
   * @return base64 SEC1 uncompressed public key (`0x04 || X(32) || Y(32)`)
   */
  private fun getPublicKeyImpl(alias: String): String {
    val publicKey = loadPrivateKeyEntry(alias).certificate.publicKey as? ECPublicKey
      ?: throw KeyNotFoundException(alias)

    return Base64.encodeToString(sec1UncompressedBytes(publicKey), Base64.NO_WRAP)
  }

  /**
   * Signs `messageBase64` (raw bytes, base64-encoded) with `alias`'s signing key once the
   * user passes `prompt`.
   *
   * Resolves `promise` with a base64 DER-encoded ECDSA signature.
   */
  private fun signImpl(alias: String, messageBase64: String, prompt: PromptOptions, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      throw UnsupportedPlatformException()
    }

    val messageBytes = try {
      Base64.decode(messageBase64, Base64.NO_WRAP)
    } catch (e: Exception) {
      throw SigningException("messageBase64 is not valid base64", e)
    }

    val signature = initSign(loadPrivateKeyEntry(alias).privateKey, SIGNATURE_ALGORITHM)
    signAfterPrompt(signature, messageBytes, prompt, promise)
  }

  /**
   * Signs `digestBase64` (exactly 32 raw bytes) with `alias`'s signing key via
   * `NONEwithECDSA` — no internal hashing, unlike [signImpl] — once the user passes `prompt`.
   *
   * Throws [DigestNoneUnauthorizedException] when `alias` predates `DIGEST_NONE`, which a
   * caller must not confuse with a transient failure: see [assertDigestNoneAuthorized].
   *
   * Resolves `promise` with a base64 DER-encoded ECDSA signature.
   */
  private fun signDigestImpl(alias: String, digestBase64: String, prompt: PromptOptions, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      throw UnsupportedPlatformException()
    }

    val digestBytes = try {
      Base64.decode(digestBase64, Base64.NO_WRAP)
    } catch (e: Exception) {
      throw InvalidDigestException("digestBase64 is not valid base64", e)
    }

    if (digestBytes.size != DIGEST_LENGTH) {
      throw InvalidDigestException("expected exactly $DIGEST_LENGTH bytes, got ${digestBytes.size} bytes")
    }

    val privateKey = loadPrivateKeyEntry(alias).privateKey
    assertDigestNoneAuthorized(alias, privateKey)

    val signature = initSign(privateKey, DIGEST_SIGNATURE_ALGORITHM)
    signAfterPrompt(signature, digestBytes, prompt, promise)
  }

  private fun initSign(privateKey: PrivateKey, algorithm: String): Signature {
    return try {
      Signature.getInstance(algorithm).apply { initSign(privateKey) }
    } catch (e: KeyPermanentlyInvalidatedException) {
      throw KeyInvalidatedException(e)
    } catch (e: Exception) {
      throw SigningException(e.message, e)
    }
  }

  /**
   * Shows `prompt` with `signature` as its `CryptoObject`, so the authentication unlocks this
   * one operation of the per-use key and nothing else, then signs `bytes` with it.
   */
  @RequiresApi(Build.VERSION_CODES.S)
  private fun signAfterPrompt(signature: Signature, bytes: ByteArray, prompt: PromptOptions, promise: Promise) {
    authenticate(prompt, BiometricPrompt.CryptoObject(signature), promise) {
      val derSignature = try {
        signature.update(bytes)
        signature.sign()
      } catch (e: KeyPermanentlyInvalidatedException) {
        // The lock can be removed while the prompt is up, after `initSign` already passed.
        throw KeyInvalidatedException(e)
      } catch (e: Exception) {
        throw SigningException(e.message, e)
      }

      promise.resolve(Base64.encodeToString(derSignature, Base64.NO_WRAP))
    }
  }

  /**
   * Shows the system authentication dialog, allowing a strong biometric or the device
   * credential, and runs `onAuthenticated` on the modules queue once the user passes it.
   * With a `cryptoObject` the dialog authorizes that one operation; without one it opens
   * the time window of time-bound keys. Rejects `promise` on cancel or a dialog error.
   */
  @RequiresApi(Build.VERSION_CODES.S)
  private fun authenticate(
    prompt: PromptOptions,
    cryptoObject: BiometricPrompt.CryptoObject?,
    promise: Promise,
    onAuthenticated: () -> Unit
  ) {
    val activity = appContext.currentActivity ?: throw AuthenticationFailedException("no foreground activity")

    if (promptInFlight) {
      throw AuthenticationFailedException("another authentication prompt is already showing")
    }
    promptInFlight = true

    // `onAuthenticationFailed` (an unrecognized finger) is left out: the dialog stays up for a retry.
    // There is no negative-button case: allowing the device credential rules out a negative button.
    val callback = object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        promptInFlight = false
        appContext.modulesQueue.launch {
          try {
            onAuthenticated()
          } catch (e: Exception) {
            promise.reject(e.toCodedException())
          }
        }
      }

      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        promptInFlight = false
        promise.reject(
          when (errorCode) {
            BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED -> UserCanceledException()
            else -> AuthenticationFailedException("$errorCode: $errString")
          }
        )
      }
    }

    appContext.mainQueue.launch {
      try {
        val biometricPrompt = BiometricPrompt.Builder(activity)
          .setTitle(prompt.title)
          .apply { prompt.subtitle?.let { setSubtitle(it) } }
          .setAllowedAuthenticators(PROMPT_AUTHENTICATORS)
          .build()

        if (cryptoObject != null) {
          biometricPrompt.authenticate(cryptoObject, CancellationSignal(), activity.mainExecutor, callback)
        } else {
          biometricPrompt.authenticate(CancellationSignal(), activity.mainExecutor, callback)
        }
      } catch (e: Exception) {
        promptInFlight = false
        promise.reject(AuthenticationFailedException(e.message, e))
      }
    }
  }

  /**
   * Distinguishes "this alias predates `DIGEST_NONE`" from a locked keystore or an invalidated
   * key, which the provider reports the same way. The distinction matters because the only cure
   * is regenerating the alias, and that rotates the key and orphans anything bound to it — so a
   * caller must never infer it from a generic signing failure.
   *
   * Best-effort: if the authorizations can't be read, signing proceeds and the provider decides.
   */
  private fun assertDigestNoneAuthorized(alias: String, privateKey: PrivateKey) {
    val digests = try {
      val keyFactory = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE_PROVIDER)
      keyFactory.getKeySpec(privateKey, KeyInfo::class.java).digests
    } catch (e: Exception) {
      Log.w(TAG, "Could not read digest authorizations for '$alias'; letting the provider decide", e)
      return
    }

    if (!digests.contains(KeyProperties.DIGEST_NONE)) {
      throw DigestNoneUnauthorizedException(alias)
    }
  }

  /**
   * Computes the ECDH shared secret between `alias`'s agreement key and
   * `peerPublicKeyBase64` (base64 SEC1 uncompressed point, `0x04 || X(32) || Y(32)`).
   * When the key's auth window has lapsed, the user passes `prompt` and the agreement
   * runs once more. Requires API 31+ (`PURPOSE_AGREE_KEY`); see [generateKeyPair].
   *
   * Resolves `promise` with the base64 32-byte big-endian X coordinate of the shared point.
   */
  private fun ecdhImpl(alias: String, peerPublicKeyBase64: String, prompt: PromptOptions, promise: Promise) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      throw EcdhUnsupportedException()
    }

    val peerPublicKey = decodePeerPublicKey(peerPublicKeyBase64)
    val privateKey = loadPrivateKeyEntry(alias).privateKey

    try {
      promise.resolve(agree(privateKey, peerPublicKey))
    } catch (e: UserNotAuthenticatedException) {
      authenticate(prompt, null, promise) {
        try {
          promise.resolve(agree(privateKey, peerPublicKey))
        } catch (retryError: UserNotAuthenticatedException) {
          throw EcdhException("still not authenticated after the prompt", retryError)
        }
      }
    }
  }

  /**
   * Runs one key agreement, rethrowing [UserNotAuthenticatedException] for [ecdhImpl] to
   * prompt on. All three calls sit in the `try`: a HAL may report the missing authentication
   * from `generateSecret` rather than `init`.
   *
   * @return base64 32-byte big-endian X coordinate of the shared point
   */
  private fun agree(privateKey: PrivateKey, peerPublicKey: PublicKey): String {
    val sharedSecret = try {
      val keyAgreement = KeyAgreement.getInstance("ECDH", ANDROID_KEYSTORE_PROVIDER)
      keyAgreement.init(privateKey)
      keyAgreement.doPhase(peerPublicKey, true)
      keyAgreement.generateSecret()
    } catch (e: UserNotAuthenticatedException) {
      throw e
    } catch (e: KeyPermanentlyInvalidatedException) {
      throw KeyInvalidatedException(e)
    } catch (e: Exception) {
      throw EcdhException(e.message, e)
    }

    return Base64.encodeToString(sharedSecret, Base64.NO_WRAP)
  }

  /**
   * Decodes and validates `peerPublicKeyBase64` as a SEC1 uncompressed P-256 point
   * (`0x04 || X(32) || Y(32)`, 65 bytes) and builds it as a `PublicKey` on the named
   * curve `secp256r1`, for use with `KeyAgreement` — never hand-built SPKI DER, so the
   * bridge stays SEC1-symmetric with [sec1UncompressedBytes].
   */
  private fun decodePeerPublicKey(peerPublicKeyBase64: String): PublicKey {
    val bytes = try {
      Base64.decode(peerPublicKeyBase64, Base64.NO_WRAP)
    } catch (e: Exception) {
      throw InvalidPeerKeyException("peerPublicKeyBase64 is not valid base64", e)
    }

    if (bytes.size != 1 + 2 * EC_COORDINATE_LENGTH) {
      throw InvalidPeerKeyException(
        "expected 65-byte SEC1 uncompressed point (0x04 || X || Y), got ${bytes.size} bytes"
      )
    }

    if (bytes[0] != 0x04.toByte()) {
      throw InvalidPeerKeyException(
        "expected SEC1 uncompressed point with 0x04 prefix, got prefix byte 0x${"%02x".format(bytes[0])}"
      )
    }

    val x = BigInteger(1, bytes.copyOfRange(1, 1 + EC_COORDINATE_LENGTH))
    val y = BigInteger(1, bytes.copyOfRange(1 + EC_COORDINATE_LENGTH, bytes.size))

    return try {
      val parameters = AlgorithmParameters.getInstance("EC")
      parameters.init(ECGenParameterSpec(EC_CURVE_NAME))
      val curveParams = parameters.getParameterSpec(ECParameterSpec::class.java)
      val keyFactory = KeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_EC)

      keyFactory.generatePublic(ECPublicKeySpec(ECPoint(x, y), curveParams))
    } catch (e: Exception) {
      throw InvalidPeerKeyException("peer point rejected for curve $EC_CURVE_NAME: ${e.message}", e)
    }
  }

  /**
   * Reports where `alias`'s key lives: `STRONGBOX`, `TRUSTED_ENVIRONMENT`,
   * `SOFTWARE`, or `UNKNOWN`. API 31+ reads `KeyInfo.securityLevel` directly;
   * API 30 falls back to `isInsideSecureHardware`, which can't tell StrongBox from a plain TEE.
   */
  private fun getSecurityLevelImpl(alias: String): String {
    val privateKey = loadPrivateKeyEntry(alias).privateKey

    return try {
      val keyFactory = KeyFactory.getInstance(privateKey.algorithm, ANDROID_KEYSTORE_PROVIDER)
      val keyInfo = keyFactory.getKeySpec(privateKey, KeyInfo::class.java)

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        when (keyInfo.securityLevel) {
          KeyProperties.SECURITY_LEVEL_STRONGBOX -> "STRONGBOX"
          KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "TRUSTED_ENVIRONMENT"
          KeyProperties.SECURITY_LEVEL_SOFTWARE -> "SOFTWARE"
          else -> "UNKNOWN"
        }
      } else {
        @Suppress("DEPRECATION")
        if (keyInfo.isInsideSecureHardware) "TRUSTED_ENVIRONMENT" else "SOFTWARE"
      }
    } catch (e: Exception) {
      throw SecurityLevelException(e.message, e)
    }
  }

  /**
   * Reads the certificate chain Keystore built for `alias`, leaf first.
   *
   * @return base64 DER certificates; empty when the key was generated without a challenge,
   *   where the chain is just the self-signed leaf
   */
  private fun getAttestationChainImpl(alias: String): List<String> {
    val chain = try {
      loadKeyStore().getCertificateChain(alias)
    } catch (e: Exception) {
      throw AttestationChainException(e.message, e)
    } ?: throw KeyNotFoundException(alias)

    if (chain.size < 2) {
      return emptyList()
    }

    return chain.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
  }

  /** Deletes `alias` from the Keystore; a no-op if it doesn't exist. */
  private fun deleteKeyImpl(alias: String) {
    try {
      val keyStore = loadKeyStore()

      if (keyStore.containsAlias(alias)) {
        keyStore.deleteEntry(alias)
      }
    } catch (e: Exception) {
      throw KeyDeletionException(e.message, e)
    }
  }

  /** Deletes every alias in the Keystore; returns the number deleted. */
  private fun eraseAllImpl(): Int {
    try {
      val keyStore = loadKeyStore()
      val aliases = keyStore.aliases().toList()

      for (alias in aliases) {
        keyStore.deleteEntry(alias)
      }

      return aliases.size
    } catch (e: Exception) {
      throw KeyDeletionException(e.message, e)
    }
  }

  private fun loadKeyStore(): KeyStore {
    val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE_PROVIDER)
    keyStore.load(null)
    return keyStore
  }

  private fun loadPrivateKeyEntry(alias: String): KeyStore.PrivateKeyEntry {
    val entry = loadKeyStore().getEntry(alias, null)
      ?: throw KeyNotFoundException(alias)

    return entry as? KeyStore.PrivateKeyEntry ?: throw KeyNotFoundException(alias)
  }

  /**
   * Builds the SEC1 uncompressed encoding (`0x04 || X(32) || Y(32)`) — never
   * X.509 SPKI, per the SDK's `normalizeConfirmationKey` contract.
   */
  private fun sec1UncompressedBytes(publicKey: ECPublicKey): ByteArray {
    val x = fixedLengthBytes(publicKey.w.affineX, EC_COORDINATE_LENGTH)
    val y = fixedLengthBytes(publicKey.w.affineY, EC_COORDINATE_LENGTH)

    return byteArrayOf(0x04) + x + y
  }

  /**
   * Encodes `value` as exactly `length` big-endian bytes: `BigInteger.toByteArray()`
   * may add a two's-complement sign byte or drop leading zeros — pad/trim both.
   */
  private fun fixedLengthBytes(value: BigInteger, length: Int): ByteArray {
    val raw = value.toByteArray()

    if (raw.size == length) {
      return raw
    }

    if (raw.size > length) {
      return raw.copyOfRange(raw.size - length, raw.size)
    }

    val padded = ByteArray(length)
    System.arraycopy(raw, 0, padded, length - raw.size, raw.size)
    return padded
  }
}
