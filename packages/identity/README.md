# `@coordination-network/identity`

Deterministic device key derivation for the coordination network: a `networkId` and a secp256k1 core (account, spending, viewing, auth) derived from a single 32-byte device secret, plus a standalone, hardware-rooted Baby Jubjub identity key with its Semaphore commitment, and ERC-5564 scheme 1 stealth-address derivation over the spending/viewing keys.

## Install

```bash
yarn add @coordination-network/identity
```

This pulls in two runtime dependencies beyond `@noble/curves`/`@noble/hashes`: `@zk-kit/eddsa-poseidon` and `poseidon-lite`, used only by `deriveEddsaKeypair` (see below). Both are exact-pinned to the versions `@semaphore-protocol/identity` itself depends on, so that a project depending on both packages dedupes to a single copy of each — see [`DERIVATION.md` §12.6](./DERIVATION.md#126-dependencies-exact-pinned).

## Quickstart

```typescript
import { generateDeviceSecret, deriveKeys } from "@coordination-network/identity"

// Generate a fresh device secret (32 random bytes, from the platform CSPRNG).
// Persist ONLY this value — see "Security notes" below.
const deviceSecret = generateDeviceSecret()

// Deterministically re-derive the full key bundle from it, any time.
const keys = deriveKeys(deviceSecret)

console.log(keys.networkId) // 0x-prefixed bytes32: a domain-separated hash of the account public key
console.log(keys.account.publicKey) // 33-byte compressed secp256k1 public key
```

Calling `deriveKeys` twice with the same `deviceSecret` always returns byte-for-byte identical keys — nothing else needs to be stored.

If a caller only needs the `networkId` (e.g. to look up or announce a device without touching its private keys), `deriveNetworkId` skips the signature and stealth/auth derivation steps:

```typescript
import { deriveNetworkId } from "@coordination-network/identity"

const networkId = deriveNetworkId(deviceSecret) // === deriveKeys(deviceSecret).networkId

// Network members use `keys.memberNetworkId`, whose last 20 bytes are the member's auth address.
```

### Credential binding (dual proof-of-possession)

Credential issuance binds two keys to one session: the device's secp256k1 account key and a hardware-backed P-256 `confirmationKey` (Secure Enclave / Android Keystore / WebCrypto). See [`DERIVATION.md` §11](./DERIVATION.md#11-credential-binding-messages-dual-proof-of-possession) for the full normative scheme.

**Wallet side** — build the messages, get the hardware key to sign its message, then sign the account message:

```typescript
import { buildBindingMessages, signAccountBinding } from "@coordination-network/identity"

// `nonce` comes from the issuer (e.g. a fresh 32-byte session challenge).
// `confirmationKey` is the device's P-256 public key (any of 65B/33B/64B encodings).
// `holderKeyCommitment` is the identity key's commitment as 32 bytes. `requestCommitment` is 32 opaque
// bytes naming the issuer and scope the user consented to; the credential package computes it.
const { deviceBindingMessage, accountBindingMessage } = buildBindingMessages(
    nonce,
    keys.account.uncompressedPublicKey,
    confirmationKey,
    holderKeyCommitment,
    requestCommitment
)

// The platform signs deviceBindingMessage with the hardware-backed P-256 key
// (SecKeyCreateSignature / Android Keystore / crypto.subtle.sign) — this
// library never signs with the P-256 key itself.
const sigB = await platformSignWithSecureEnclave(deviceBindingMessage)

// The account key signs accountBindingMessage (EIP-191, deterministic).
const { signature: sigA } = signAccountBinding(keys.account.privateKey, nonce, confirmationKey)

// Send `nonce`, `confirmationKey`, `sigA`, `sigB` to the issuer.
```

**Issuer side** — a single call verifies both proofs against one derived `networkId`:

```typescript
import { verifyCredentialBinding } from "@coordination-network/identity"

const { valid, networkId } = verifyCredentialBinding({
    nonce,
    accountPublicKey, // the account's public key, as claimed by the wallet
    confirmationKey,
    holderKeyCommitment,
    requestCommitment, // recomputed by the issuer from its own id and the scope it will sign
    accountSignature: sigA,
    deviceSignature: sigB
})

if (!valid) {
    throw new Error("credential binding failed verification")
}
```

### Baby Jubjub identity key and Semaphore commitment

`deriveEddsaKeypair` derives a stable, device-level Baby Jubjub EdDSA keypair and Semaphore-v4-compatible identity commitment — a standalone derivation, additive to `deriveKeys`. Unlike the secp256k1 core, this key is **hardware-rooted**, not derived from `deviceSecret`: its input is an ECDH shared secret computed by the platform's hardware-backed P-256 device agreement key (a separate key from the device signing key that is credential-binding's `confirmationKey`) against a fixed, NUMS peer point this package pins. See [`DERIVATION.md` §12](./DERIVATION.md#12-baby-jubjub-identity-key-and-semaphore-commitment) for the full normative scheme and the rationale for hardware-rooting it this way.

`derivePaymasterKeypair` accepts the same ECDH shared secret but uses a separate domain tag. Its commitment may be published as a paymaster group leaf; the credential holder commitment returned by `deriveEddsaKeypair` must not be published there.

```typescript
import { deriveEddsaKeypair, eddsaPeerPointBytes } from "@coordination-network/identity"

// The platform layer computes this natively, inside the secure element —
// e.g. Android Keystore KeyAgreement("ECDH") against the pinned peer point:
//   ecdhSharedSecret = await keystore.ecdh(alias, base64(eddsaPeerPointBytes()))
const ecdhSharedSecret = await platformEcdh(agreementKeyAlias, eddsaPeerPointBytes())

const eddsa = deriveEddsaKeypair(ecdhSharedSecret)

console.log(eddsa.commitment) // bigint — the Semaphore v4 identity commitment
console.log(eddsa.publicKey) // [bigint, bigint] — the Baby Jubjub public key
```

**This key is not recoverable from `deviceSecret` alone.** If the hardware device agreement key is lost (device reset, Keystore wipe, removal of the secure lock screen, replaced secure element), this device's Semaphore commitment cannot be recomputed — a new hardware key derives a new, unrelated identity key. This is a deliberate trade-off of rooting the key in hardware at all; see [`DERIVATION.md` §12.1](./DERIVATION.md#121-the-formula).

**`eddsa.seed` is `Hex` — decode it to raw bytes before handing it to Semaphore.** `@semaphore-protocol/identity`'s `Identity` constructor accepts a hex _string_ as raw UTF-8 text, not as hex to decode, so passing `eddsa.seed` directly derives a different, unrelated identity — and it will not throw, it will just silently be wrong. Decode the hex to bytes first with whatever hex utility your project already uses (e.g. viem's/ethers' `hexToBytes`, or `Buffer.from(seed.slice(2), "hex")` in Node):

```typescript
import { Identity } from "@semaphore-protocol/identity"

function hexToBytes(hex: `0x${string}`): Uint8Array {
    const body = hex.slice(2)
    return Uint8Array.from(Buffer.from(body, "hex"))
}

// Correct: decode the hex seed to raw bytes first.
const identity = new Identity(hexToBytes(eddsa.seed))
identity.commitment === eddsa.commitment // true

// WRONG — silently derives a different identity, does not throw:
// new Identity(eddsa.seed).commitment !== eddsa.commitment
```

### Stealth addresses (ERC-5564 scheme 1)

A sender derives a fresh, unlinkable Ethereum address for every payment from the recipient's published meta-address. Only the recipient's viewing key can detect it, and only the spending key controls it. Formulas and byte-level choices are specified in [`specs/05-stealth-addresses.md`](../../specs/05-stealth-addresses.md), and conformance is cross-checked against ScopeLift's `stealth-address-sdk` in `tests/stealth-crosschecks.test.ts`.

```typescript
import {
    encodeMetaStealthAddress,
    buildAnnouncement,
    generateEphemeralKey,
    generateStealthAddress,
    checkStealthAddress,
    computeSharedSecret,
    getViewTag,
    generateStealthPrivateKey
} from "@coordination-network/identity"

// Recipient can publish the 66-byte meta-address (this is what IdentityRegistry stores).
const metaStealthAddress = encodeMetaStealthAddress({
    spendingPublicKey: keys.spending.publicKey,
    viewingPublicKey: keys.viewing.publicKey
})

// Fresh ephemeral key per load, derive the stealth address, announce.
const ephemeral = generateEphemeralKey()
const stealthAddress = generateStealthAddress({
    spendingPublicKey: keys.spending.publicKey,
    viewingPublicKey: keys.viewing.publicKey,
    ephemeralPrivateKey: ephemeral.privateKey
})
const viewTag = getViewTag(computeSharedSecret({ privateKey: ephemeral.privateKey, publicKey: keys.viewing.publicKey }))
// announce (stealthAddress, ephemeral.publicKey, viewTag) via the ERC-5564 Announcer

// Or build the whole announcement payload in one call (ephemeral key generated internally):
const announcement = buildAnnouncement({ metaStealthAddress })

// Receiver can scan announcements with the viewing key
const isOwned = checkStealthAddress({
    stealthAddress,
    ephemeralPublicKey: ephemeral.publicKey,
    viewTag,
    viewingPrivateKey: keys.viewing.privateKey,
    spendingPublicKey: keys.spending.publicKey
})

// Recover the private key controlling the stealth address.
const stealthPrivateKey = generateStealthPrivateKey({
    ephemeralPublicKey: ephemeral.publicKey,
    viewingPrivateKey: keys.viewing.privateKey,
    spendingPrivateKey: keys.spending.privateKey
})
```

## API reference

All hex values are lowercase, `0x`-prefixed strings (type `Hex`). Every function documented below is exported from the package root. See [`DERIVATION.md`](./DERIVATION.md) for the exact formulas behind each one (stealth-address formulas: [`specs/05-stealth-addresses.md`](../../specs/05-stealth-addresses.md)).

| Export                           | Kind     | Signature                                                                                                                                                                                   | Description                                                                                                                                                                                                                                                       |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `generateDeviceSecret`           | function | `() => Hex`                                                                                                                                                                                 | Generates a fresh 32-byte device secret via `globalThis.crypto.getRandomValues`.                                                                                                                                                                                  |
| `deriveKeys`                     | function | `(deviceSecret: Uint8Array \| Hex) => DerivedKeys`                                                                                                                                          | Derives the full `v2` identity (`networkId`, `memberNetworkId` + account/spending/viewing/auth keypairs) from a device secret.                                                                                                                                    |
| `deriveNetworkId`                | function | `(deviceSecret: Uint8Array \| Hex) => Hex`                                                                                                                                                  | Cheap path: derives only the account key and `networkId`, skipping the signature and stealth/auth derivation.                                                                                                                                                     |
| `deriveAccountKeypair`           | function | `(deviceSecret: Uint8Array \| Hex) => Secp256k1Keypair`                                                                                                                                     | Derives the root account keypair (`hashToScalar(DOMAIN_ACCOUNT, deviceSecret)`).                                                                                                                                                                                  |
| `signDerivationMessage`          | function | `(accountPrivateKey: Hex \| Uint8Array) => Hex`                                                                                                                                             | Deterministic EIP-191 personal-sign signature over the fixed domain message, using the account private key.                                                                                                                                                       |
| `deriveStealthKeys`              | function | `(sig64: Uint8Array \| Hex) => { spending: Secp256k1Keypair; viewing: Secp256k1Keypair }`                                                                                                   | Derives spending/viewing keypairs from the derivation-message signature (FluidKey `generateKeysFromSignature` semantics).                                                                                                                                         |
| `deriveAuthKeypair`              | function | `(sig64: Uint8Array \| Hex) => Secp256k1Keypair`                                                                                                                                            | Derives the auth keypair (`hashToScalar(DOMAIN_AUTH, sig64)`).                                                                                                                                                                                                    |
| `computeSharedSecret`            | function | `({ privateKey: Hex; publicKey: Hex }) => Uint8Array`                                                                                                                                       | ERC-5564 hashed shared secret: `keccak256` of the 33-byte compressed ECDH point. Symmetric — sender passes `(ephemeralPriv, viewingPub)`, recipient `(viewingPriv, ephemeralPub)`.                                                                                |
| `getViewTag`                     | function | `(hashedSharedSecret: Uint8Array) => number`                                                                                                                                                | The one-byte view tag: first byte of the hashed shared secret, published in announcements.                                                                                                                                                                        |
| `getStealthPublicKey`            | function | `({ spendingPublicKey: Hex; hashedSharedSecret: Uint8Array }) => Uint8Array`                                                                                                                | Scheme 1 point math: `P_spend + (s_h mod n)·G`, returned as a 65-byte uncompressed key.                                                                                                                                                                           |
| `publicKeyToAddress`             | function | `(uncompressedPublicKey: Uint8Array) => Address`                                                                                                                                            | Standard Ethereum address derivation: `keccak256(X \|\| Y)`, last 20 bytes.                                                                                                                                                                                       |
| `generateEphemeralKey`           | function | `() => Secp256k1Keypair`                                                                                                                                                                    | Fresh CSPRNG keypair for one load. MUST be single-use — reuse links the payments it was used for.                                                                                                                                                                 |
| `generateStealthAddress`         | function | `({ spendingPublicKey, viewingPublicKey, ephemeralPrivateKey }) => Address`                                                                                                                 | Sender side: derives the fresh stealth address for a load.                                                                                                                                                                                                        |
| `generateStealthPrivateKey`      | function | `({ ephemeralPublicKey, viewingPrivateKey, spendingPrivateKey }) => Hex`                                                                                                                    | Recipient side: recovers the private key controlling a stealth address — `(p_spend + s_h) mod n`.                                                                                                                                                                 |
| `checkStealthAddress`            | function | `({ stealthAddress, ephemeralPublicKey, viewTag, viewingPrivateKey, spendingPublicKey }) => boolean`                                                                                        | Recipient side: view-tag filter then full recompute; `true` when the announcement is addressed to these keys. Case-insensitive on `stealthAddress`. Throws on malformed announcement data — scan loops should try/catch per announcement.                         |
| `validateMetaStealthAddress`     | function | `(metaStealthAddress: string) => boolean`                                                                                                                                                   | Shape + curve check for a 66-byte meta-address: `0x` + 132 hex chars, both halves valid compressed points.                                                                                                                                                        |
| `encodeMetaStealthAddress`       | function | `({ spendingPublicKey, viewingPublicKey }) => Hex`                                                                                                                                          | The 66-byte compressed `spending \|\| viewing` concatenation `IdentityRegistry` stores. Validates before emitting (the registry is write-once) — throws `InvalidMetaStealthAddressError`.                                                                         |
| `encodeMetaStealthAddressUri`    | function | `({ spendingPublicKey, viewingPublicKey }) => string`                                                                                                                                       | The `st:eth:0x…` display form (ERC-5564 URI). Never stored onchain.                                                                                                                                                                                               |
| `decodeMetaStealthAddress`       | function | `(metaStealthAddress: string) => { spendingPublicKey: Hex; viewingPublicKey: Hex }`                                                                                                         | Splits a 66-byte meta-address (raw or `st:eth:` form) into its two keys. No validation — pair with `validateMetaStealthAddress` for untrusted input.                                                                                                              |
| `buildAnnouncement`              | function | `({ metaStealthAddress: Hex }) => { schemeId: 1; stealthAddress: Address; ephemeralPublicKey: Hex; metadata: Hex }`                                                                         | Builds the ERC-5564 announcement payload for a fresh stealth address from a recipient's meta-address. Generates the single-use ephemeral key internally; `metadata` is the one-byte view tag.                                                                     |
| `deriveEddsaKeypair`             | function | `(ecdhSharedSecret: Uint8Array \| Hex) => EddsaKeypair`                                                                                                                                     | Derives the Baby Jubjub identity keypair and its Semaphore v4 identity commitment from a hardware-computed ECDH shared secret against `EDDSA_PEER_POINT_HEX`.                                                                                                     |
| `eddsaPeerPointBytes`            | function | `() => Uint8Array`                                                                                                                                                                          | Returns a fresh 65-byte SEC1 copy of the fixed EdDSA peer point `Q`, for platform ECDH calls.                                                                                                                                                                     |
| `computeEddsaPeerPoint`          | function | `() => Uint8Array`                                                                                                                                                                          | Recomputes `Q` via RFC 9380 hash-to-curve at runtime — reproducibility evidence that `EDDSA_PEER_POINT_HEX` is not hand-picked.                                                                                                                                   |
| `normalizeEcdhSharedSecret`      | function | `(secret: Uint8Array \| Hex \| string) => Uint8Array`                                                                                                                                       | Validates/normalizes an ECDH shared secret to exactly 32 bytes.                                                                                                                                                                                                   |
| `computeNetworkId`               | function | `(uncompressedPublicKey: Uint8Array \| Hex) => Hex`                                                                                                                                         | Computes a user's bytes32 `networkId`, `keccak256(utf8(DOMAIN_NETWORK_ID) \|\| X \|\| Y)`, from an uncompressed secp256k1 public key.                                                                                                                             |
| `computeMemberNetworkId`         | function | `(uncompressedPublicKey: Uint8Array \| Hex) => Hex`                                                                                                                                         | Computes a member's bytes32 id, `keccak256(X \|\| Y)`; its last 20 bytes are the member's auth address.                                                                                                                                                           |
| `hashToScalar`                   | function | `(tag: string, input: Uint8Array) => Uint8Array`                                                                                                                                            | The normative hash-to-secp256k1-scalar primitive (keccak256, reject-and-retry counter).                                                                                                                                                                           |
| `hashToScalarWith`               | function | `(hashFn: HashFn, tag: string, input: Uint8Array) => Uint8Array`                                                                                                                            | Same algorithm as `hashToScalar` with an injectable hash function (used to test the retry branch).                                                                                                                                                                |
| `isValidScalar`                  | function | `(scalar: Uint8Array) => boolean`                                                                                                                                                           | Tests whether `scalar` is a valid secp256k1 private key (32 bytes, integer in `[1, n)`).                                                                                                                                                                          |
| `scalarToKeypair`                | function | `(scalar: Uint8Array) => Secp256k1Keypair`                                                                                                                                                  | Expands a validated 32-byte scalar into a full keypair (compressed + uncompressed public keys).                                                                                                                                                                   |
| `normalizeDeviceSecret`          | function | `(secret: Uint8Array \| Hex \| string) => Uint8Array`                                                                                                                                       | Validates/normalizes a device secret to exactly 32 bytes.                                                                                                                                                                                                         |
| `normalizeConfirmationKey`       | function | `(confirmationKey: Uint8Array \| Hex) => Uint8Array`                                                                                                                                        | Normalizes a P-256 `confirmationKey` (65B/33B/64B) to its raw 64-byte `X \|\| Y`, validating it is on-curve.                                                                                                                                                      |
| `computeConfirmationKeyHash`     | function | `(confirmationKey: Uint8Array \| Hex) => Hex`                                                                                                                                               | Computes `confirmationKeyHash`, the RFC 7638 JWK thumbprint of a P-256 `confirmationKey`.                                                                                                                                                                         |
| `buildDeviceBindingMessage`      | function | `(nonce, networkId, holderKeyCommitment, requestCommitment) => Uint8Array`                                                                                                                  | Low-level: builds the 128-byte `nonce \|\| networkId \|\| holderKeyCommitment \|\| requestCommitment` message signed by the P-256 confirmation key.                                                                                                               |
| `buildAccountBindingMessage`     | function | `(nonce, confirmationKey, networkId) => Uint8Array`                                                                                                                                         | Low-level: builds the 96-byte `nonce \|\| confirmationKeyHash \|\| networkId` message signed by the account key.                                                                                                                                                  |
| `buildBindingMessages`           | function | `(nonce, accountUncompressedPublicKey, confirmationKey, holderKeyCommitment, requestCommitment) => { networkId: Hex; deviceBindingMessage: Uint8Array; accountBindingMessage: Uint8Array }` | Wallet-side: builds both binding messages with `networkId` derived internally from the account public key.                                                                                                                                                        |
| `signAccountBinding`             | function | `(accountPrivateKey: Hex \| Uint8Array, nonce, confirmationKey) => { signature: Hex; networkId: Hex }`                                                                                      | Produces `sig_A`: the deterministic EIP-191 signature over `accountBindingMessage`, with `networkId` derived internally.                                                                                                                                          |
| `verifyAccountBindingSignature`  | function | `({ nonce, confirmationKey, accountPublicKey, signature }) => boolean`                                                                                                                      | Issuer-side: verifies `sig_A` against `accountPublicKey`, with `networkId` derived internally.                                                                                                                                                                    |
| `verifyDeviceBindingSignature`   | function | `({ nonce, networkId, confirmationKey, holderKeyCommitment, requestCommitment, signature }) => boolean`                                                                                     | Issuer-side: verifies `sig_B` (raw-compact or DER, `lowS` not enforced). `networkId` is a parameter here — the one place it cannot be derived internally; see [`DERIVATION.md` §11.5](./DERIVATION.md#115-mutual-binding-and-the-locally-derived-networkid-must). |
| `verifyCredentialBinding`        | function | `({ nonce, accountPublicKey, confirmationKey, holderKeyCommitment, requestCommitment, accountSignature, deviceSignature }) => { valid: boolean; networkId: Hex }`                           | The full issuer gate: derives one `networkId` and checks both `sig_A` and `sig_B` against it.                                                                                                                                                                     |
| `KEY_DERIVATION_VERSION`         | constant | `"v2"`                                                                                                                                                                                      | The current derivation scheme version, also the value of `DerivedKeys.version`.                                                                                                                                                                                   |
| `FIXED_DOMAIN_MSG`               | constant | `"coordination-network/identity/v1"`                                                                                                                                                        | Fixed message signed by `signDerivationMessage`.                                                                                                                                                                                                                  |
| `DOMAIN_ACCOUNT`                 | constant | `"coordination-network/identity/v1/account"`                                                                                                                                                | Domain-separation tag for the account key.                                                                                                                                                                                                                        |
| `DOMAIN_AUTH`                    | constant | `"coordination-network/identity/v1/auth"`                                                                                                                                                   | Domain-separation tag for the auth key.                                                                                                                                                                                                                           |
| `DOMAIN_NETWORK_ID`              | constant | `"coordination-network/identity/v2/network-id"`                                                                                                                                             | Domain-separation tag prefixed to `X \|\| Y` for a user's `networkId`.                                                                                                                                                                                            |
| `DOMAIN_EDDSA_PEER`              | constant | `"coordination-network/identity/v1/eddsa/peer"`                                                                                                                                             | Domain-separation tag hashed to produce the fixed EdDSA peer point `Q` (`EDDSA_PEER_POINT_HEX`).                                                                                                                                                                  |
| `EDDSA_PEER_POINT_HEX`           | constant | `Hex`                                                                                                                                                                                       | The fixed, NUMS P-256 peer point ECDH'd against the hardware device agreement key to produce this device's `deriveEddsaKeypair` input.                                                                                                                            |
| `DOMAIN_EDDSA`                   | constant | `"coordination-network/identity/v1/eddsa"`                                                                                                                                                  | Domain-separation tag for the Baby Jubjub EdDSA seed, applied to the ECDH shared secret.                                                                                                                                                                          |
| `BINDING_NONCE_LENGTH`           | constant | `32`                                                                                                                                                                                        | Required byte length of `nonce` and `networkId` in the credential-binding messages.                                                                                                                                                                               |
| `COMPRESSED_PUBLIC_KEY_LENGTH`   | constant | `33`                                                                                                                                                                                        | SEC1-compressed secp256k1 public key length in bytes.                                                                                                                                                                                                             |
| `META_STEALTH_ADDRESS_LENGTH`    | constant | `66`                                                                                                                                                                                        | ERC-6538 scheme 1 meta-stealth address length: compressed spending ‖ viewing keys.                                                                                                                                                                                |
| `META_STEALTH_URI_PREFIX`        | constant | `"st:eth:"`                                                                                                                                                                                 | ERC-5564 offchain display prefix — never stored onchain.                                                                                                                                                                                                          |
| `ERC_5564_SCHEME_ID`             | constant | `1`                                                                                                                                                                                         | ERC-5564 scheme id for secp256k1 with view tags.                                                                                                                                                                                                                  |
| `KeygenError`                    | class    | extends `Error`, has `code: KeygenErrorCode`                                                                                                                                                | Base class for every error this package throws.                                                                                                                                                                                                                   |
| `InvalidDeviceSecretError`       | class    | extends `KeygenError` (`code: "INVALID_DEVICE_SECRET"`)                                                                                                                                     | Thrown when a device secret is not exactly 32 bytes.                                                                                                                                                                                                              |
| `InvalidEcdhSecretError`         | class    | extends `KeygenError` (`code: "INVALID_ECDH_SECRET"`)                                                                                                                                       | Thrown when an ECDH shared secret passed to `deriveEddsaKeypair` is not exactly 32 bytes.                                                                                                                                                                         |
| `DerivationFailureError`         | class    | extends `KeygenError` (`code: "DERIVATION_FAILURE"`)                                                                                                                                        | Thrown on an (unreachable in practice, ~2⁻¹²⁸) scalar-derivation failure.                                                                                                                                                                                         |
| `InvalidBindingInputError`       | class    | extends `KeygenError` (`code: "INVALID_BINDING_INPUT"`)                                                                                                                                     | Thrown when a credential-binding input is malformed. A well-formed signature that fails to verify returns `false` instead — see [`DERIVATION.md` §11](./DERIVATION.md#11-credential-binding-messages-dual-proof-of-possession).                                   |
| `InvalidMetaStealthAddressError` | class    | extends `KeygenError` (`code: "INVALID_META_STEALTH_ADDRESS"`)                                                                                                                              | Thrown by `encodeMetaStealthAddress` when a public key fails validation before the write-once registry encode.                                                                                                                                                    |
| `Hex`                            | type     | `` `0x${string}` ``                                                                                                                                                                         | A `0x`-prefixed lowercase hex string — the wire representation of every byte value in this package.                                                                                                                                                               |
| `Address`                        | type     | `Hex`                                                                                                                                                                                       | An Ethereum address (20 bytes as lowercase hex). Alias of `Hex` — documentation, not enforcement.                                                                                                                                                                 |
| `Secp256k1Keypair`               | type     | `{ privateKey: Hex; publicKey: Hex; uncompressedPublicKey: Hex }`                                                                                                                           | Shape of every secp256k1 keypair in the secp256k1 core.                                                                                                                                                                                                           |
| `DerivedKeys`                    | type     | `{ version: "v2"; networkId: Hex; memberNetworkId: Hex; account, spending, viewing, auth: Secp256k1Keypair }`                                                                               | Shape returned by `deriveKeys`.                                                                                                                                                                                                                                   |
| `EddsaKeypair`                   | type     | `{ seed: Hex; secretScalar: bigint; publicKey: [bigint, bigint]; commitment: bigint }`                                                                                                      | Shape returned by `deriveEddsaKeypair`, the identity key. `seed` is `Hex` for storage/transport only — decode to raw bytes before re-feeding Semaphore.                                                                                                           |
| `KeygenErrorCode`                | type     | `"INVALID_DEVICE_SECRET" \| "INVALID_ECDH_SECRET" \| "DERIVATION_FAILURE" \| "INVALID_BINDING_INPUT" \| "INVALID_META_STEALTH_ADDRESS"`                                                     | Discriminant for branching on `KeygenError#code`.                                                                                                                                                                                                                 |
| `HashFn`                         | type     | `(input: Uint8Array) => Uint8Array`                                                                                                                                                         | Shape of an injectable 32-byte-output hash function, as accepted by `hashToScalarWith`.                                                                                                                                                                           |

## Security notes

- **The device secret is not the only persistent root this library depends on.** It is the sole root of `deriveKeys`'s secp256k1 core (`account`, `spending`, `viewing`, `auth`) and the `networkId` — re-derive those with `deriveKeys` whenever you need them instead of storing them separately. The identity key (`deriveEddsaKeypair`) is different: it is rooted in the platform's non-exportable hardware device agreement key, so that key is a second persistent root this device's identity depends on — and, unlike the device secret, it is not recoverable if lost. See [`DERIVATION.md` §12.1](./DERIVATION.md#121-the-formula).
- **Storage is out of scope for this package.** Store the device secret in the platform's secure keystore (e.g. iOS Keychain, Android Keystore, an OS-level secret store, or a hardware-backed enclave), not in plain application storage. This package's model is _store one secret, re-derive on demand_, not _derive once and persist the results_.
- **No PII is required or accepted anywhere in this derivation chain.** The device secret is opaque random bytes; nothing in `deriveKeys` takes or produces personally identifying input.
- **JavaScript offers no memory-hygiene guarantees, and this library does not pretend otherwise.** It never logs secret material, and it keeps no module-level state (no key, signature, or secret survives past the call that produced it) — but it cannot zero out memory or JS engine-internal copies after use. Wiping sensitive buffers, if required, is the responsibility of the platform layer that owns the device secret's storage, not of this library.
- **Ephemeral keys MUST be fresh per load.** Nothing in the API prevents reusing an `ephemeralPrivateKey` across `generateStealthAddress` calls, but reuse derives the same stealth address twice, publicly linking those loads.

See [`DERIVATION.md`](./DERIVATION.md) for the full normative derivation spec, including rationale for each design choice and the conformance test vectors.

## License

MIT, see [`LICENSE`](./LICENSE).
