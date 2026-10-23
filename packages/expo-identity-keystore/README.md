# `@coordination-network/expo-identity-keystore`

Expo Module for the user app's and the `identity-testbed` app's hardware-backed device keys (P-256): an Android Keystore native module (StrongBox where available, else TEE) exposing key generation, signing, and ECDH behind user authentication, plus an in-memory `SoftwareKeystore` implementing the same interface for iOS, Expo Go, and jest.

Install with `yarn add @coordination-network/expo-identity-keystore`. The native module is Android only (API 31+ for key operations); on iOS `getKeystore()` returns `null`.

## Layout

- `expo-module.config.json`, `android/` — the Android Keystore native module (`IdentityKeystoreModule.kt`).
- `src/native.ts` — the `Keystore` interface, the `KEYSTORE_ERROR_CODES` and `keystoreErrorCode()`, and `getKeystore()`, which loads the native module or returns `null` where it isn't available.
- `src/software-keystore.ts` — `SoftwareKeystore`, a software stand-in implementing the same interface.
- `src/device-signer.ts` — `createDeviceSigner`, wrapping a `Keystore` alias and a prompt as a signer with a cached public key.
- `src/encoding.ts` — base64/SEC1/JWK helpers, including `derToCompact` (DER → compact, low-S).

## Usage

```typescript
import { getKeystore, SoftwareKeystore, createDeviceSigner } from "@coordination-network/expo-identity-keystore"

// null on iOS, Expo Go, or jest — fall back to SoftwareKeystore there.
const keystore = getKeystore() ?? new SoftwareKeystore()

// Provisioning is an explicit, one-time app step — createDeviceSigner never does it.
if (!(await keystore.hasKey("signing-key"))) {
    await keystore.generateKey("signing-key", { purpose: "sign" }) // { publicKey, securityLevel }
}

// To attest the key, pass attestationChallenge (base64, at most 128 bytes) and read the chain after.
// With a challenge, generateKey fails rather than fall back to an unattested key.
// await keystore.generateKey("signing-key", { purpose: "sign", attestationChallenge })
// const chain = await keystore.getAttestationChain("signing-key") // base64 DER, leaf first

// The prompt is the system dialog's text, shown on every sign/signDigest.
const signer = createDeviceSigner(keystore, "signing-key", {
    title: "Share a proof",
    subtitle: "Proves your credential"
})
const jwk = await signer.getPublicKeyJwk() // no prompt
const signature = await signer.sign(message) // 64-byte compact, low-S
```

## Key purposes and user authentication

Each key has one purpose, fixed at `generateKey`:

| Purpose | Operations           | Prompt                                                                                       |
| ------- | -------------------- | -------------------------------------------------------------------------------------------- |
| `sign`  | `sign`, `signDigest` | every call, bound to that one signature through a `BiometricPrompt` `CryptoObject`           |
| `agree` | `ecdh`               | only when the last authentication is over 10 s old; the module then prompts and retries once |

The agreement key gets a time window because a `KeyAgreement` `CryptoObject` needs Android 16 QPR2, so per-use auth can't cover ECDH on most phones.

Both keys accept a strong biometric or the device credential (PIN, pattern, password). So `generateKey` refuses without a secure lock screen, and refuses below Android 12 (API 31), where `PURPOSE_AGREE_KEY` doesn't exist. Enrolling a new fingerprint keeps both keys; removing or resetting the screen lock invalidates them for good. Only one prompt shows at a time: an overlapping call is refused. The prompt text comes from the JS caller, so it says what the app asks it to say.

A native rejection carries one of these `code`s, read with `keystoreErrorCode(error)`:

| Code                        | Meaning                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| `ERR_USER_CANCELED`         | the user dismissed the prompt                                                                       |
| `ERR_KEY_INVALIDATED`       | the screen lock was removed or reset; delete and regenerate the key                                 |
| `ERR_NO_SECURE_LOCK_SCREEN` | `generateKey` without a PIN, pattern or password set                                                |
| `ERR_UNSUPPORTED_PLATFORM`  | below Android 12                                                                                    |
| `ERR_AUTHENTICATION_FAILED` | lockout, a system cancel, a dialog error, no foreground activity, or another prompt already showing |

## Security notes

- `SoftwareKeystore` is **not** hardware-backed: keys live in a JS `Map` for the process lifetime. It exists so iOS, Expo Go, and jest exercise the same code paths as the real Keystore, not to stand in for it in production. It enforces each key's purpose like the native module, shows no prompts, and records each one it would show in `prompts`.
- `Keystore.generateKey` (re)provisions the alias — calling it again silently rotates the key and invalidates every prior signature. Use `hasKey`/`getPublicKey` to check for and read an existing key without touching it. `createDeviceSigner` never calls `generateKey`: it reads the public key with `getPublicKey` on first use and caches it, rejecting if the alias hasn't been provisioned yet — provisioning stays a separate, explicit step for the app.
- An alias provisioned before this module authorized `DIGEST_NONE` can never `signDigest`: digest authorizations, like purposes, are fixed at key creation. `signDigest` reports exactly that case as `DigestNoneUnauthorizedException`, so never treat a generic signing failure as grounds to delete and regenerate — a locked keystore looks the same. Regenerating rotates the key, and with it both `deviceKeyCommitment` and `holderKeyCommitment`: every credential held against the alias is orphaned and has to be re-issued. The on-chain registration is unaffected, since `networkId` and the meta-stealth address derive from the software `deviceSecret` rather than this alias.
- `getAttestationChain(alias)` returns `[]` for a key generated without a challenge, on `SoftwareKeystore`, and when the platform returns fewer than two certificates (a self-signed chain proves nothing).
- `signDigest` signs any 32 bytes it is given, behind a prompt for that one call. The prompt is what stops silent signing, so code in the app process can still get any digest signed if the user approves the dialog.
- Give each signing protocol its own alias. A signature made with `signDigest` over `SHA-256(m)` verifies exactly as one made with `sign(m)`, so a verifier cannot tell which call produced it; separate aliases for binding and for presentations keep the two protocols from overlapping on one key.
