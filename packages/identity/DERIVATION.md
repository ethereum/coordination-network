# Key derivation scheme `v2` — normative specification

This document is the normative, spec-liftable description of `@coordination-network/identity`'s key derivation scheme. It is written to be read independently of the source: every formula, constant, and edge case a compliant reimplementation needs is here. Where this document and the source (`src/`) disagree, treat that as a bug in one of the two — they must never diverge.

Everything below is versioned as **`v2`** (`KEY_DERIVATION_VERSION`). The core of the scheme is **all-ECDSA (secp256k1)**: account, spending, viewing, and auth (§3–§5) are the complete secp256k1 core, unchanged since §7's original ECDSA-only decision. `v2` additionally defines one explicitly-versioned, additive Baby Jubjub identity key layered on top of that secp256k1 core; see [§7](#7-team-decision-ecdsa-only-no-eddsa) for the history and [§12](#12-baby-jubjub-identity-key-and-semaphore-commitment) for its normative definition.

## 0. Notation

- `||` — byte concatenation.
- `keccak256(x)` — the Keccak-256 hash of byte string `x`, producing 32 bytes.
- `utf8(s)` — the UTF-8 byte encoding of string `s`.
- `n` — the secp256k1 group order (`secp256k1.CURVE.n` in `@noble/curves`).
- `BigInt(x)` — the big-endian unsigned integer encoded by byte string `x`.
- A **scalar** is _valid_ iff it is exactly 32 bytes and `1 <= BigInt(scalar) < n`.
- `Hex` — a `0x`-prefixed, lowercase hex string.

## 1. Input: the device secret

A **device secret** is exactly 32 bytes: a `Uint8Array` of length 32, or a `0x`-prefixed string of exactly 64 hex characters. This is the sole root of the secp256k1 core (account, spending, viewing, auth) and `networkId`; there is no other entropy input anywhere in that chain. `normalizeDeviceSecret` (`src/bytes.ts`) is the sole validator — anything else (wrong length, missing/malformed hex) throws `InvalidDeviceSecretError`. The identity key (§12) is the one exception to "sole root": it is instead rooted in a hardware P-256 key, deliberately not re-derivable from `deviceSecret` alone — see §12.1.

`generateDeviceSecret()` (`src/device-secret.ts`) produces a fresh device secret as 32 bytes from `globalThis.crypto.getRandomValues`, returned as `Hex`. It throws `KeygenError` (code `DERIVATION_FAILURE`) if no such RNG is available on the platform — this package never falls back to a weaker source.

## 2. The hash-to-scalar primitive

`hashToScalar(tag, input)` (`src/hash-to-scalar.ts`) is the single normative construction used everywhere a domain tag and some input bytes need to become a uniformly-distributed, in-range secp256k1 scalar:

```
for counter = 0 .. 255:
    candidate = keccak256(utf8(tag) || input || bytes([counter]))
    if 1 <= BigInt(candidate) < n:
        return candidate
throw DerivationFailureError   # unreachable in practice, ~2^-128 per iteration
```

- The counter byte is a single unsigned byte (`0..255`) appended after `input`, making each of the (at most) 256 candidates an independent keccak256 evaluation.
- The probability that a single candidate falls outside `[1, n)` is `~2^-128` (since `n` is within `2^128` of `2^256`); exhausting all 256 counters without an acceptance is therefore unreachable in any practical sense, but the reject-and-retry loop and the `DerivationFailureError` throw exist so the construction has no silent failure mode.
- `hashToScalarWith(hashFn, tag, input)` is the same algorithm parameterized over an injectable hash function, used only to drive the retry branch deterministically in tests; production derivation always calls `hashToScalar`, which fixes `hashFn = keccak_256`.

This primitive is used for the **account** key (§3) and the **auth** key (§5). It is _not_ used for the spending/viewing keys (§4), which intentionally have no reject-and-retry (see the FluidKey-compatibility rationale there).

## 3. Account key

```
accountPrivKey = hashToScalar(DOMAIN_ACCOUNT, deviceSecret)
```

where `DOMAIN_ACCOUNT = "coordination-network/identity/v1/account"`.

The 32-byte scalar is expanded (`scalarToKeypair`, `src/keypair.ts`) into a full `Secp256k1Keypair`:

- `privateKey` — the 32-byte scalar.
- `publicKey` — the 33-byte SEC1 **compressed** public key (`getPublicKey(privateKey, true)`).
- `uncompressedPublicKey` — the 65-byte SEC1 **uncompressed** public key, `0x04 || X || Y` (`getPublicKey(privateKey, false)`).

This is the root key of the `v2` model: the `networkId` (§6) and the derivation-message signature (§4, whose halves seed spending/viewing) are both computed from it, and nothing downstream of it needs the device secret again.

## 4. Derivation-message signature, and the spending/viewing keys

### 4.1 The fixed derivation message and its EIP-191 digest

```
FIXED_DOMAIN_MSG = "coordination-network/identity/v1"   # 32 UTF-8 bytes
prefix = utf8("\x19Ethereum Signed Message:\n" || decimal(len(utf8(FIXED_DOMAIN_MSG))))
digest = keccak256(prefix || utf8(FIXED_DOMAIN_MSG))
```

`len(...)` is the **UTF-8 byte length** of `FIXED_DOMAIN_MSG` — 32 — not its character count (they happen to coincide here since the message is ASCII, but implementations must compute the byte length, not assume it). This is the standard EIP-191 `personal_sign` digest construction, applied to a message that is fixed by the scheme rather than user-supplied.

### 4.2 The signature

```
sig = ECDSA-sign(digest, accountPrivKey)   # secp256k1, RFC-6979 deterministic, lowS: true, NO extraEntropy
sig64 = compact(sig)                        # 64 bytes: r (32) || s (32)
```

- **RFC-6979 deterministic**: the nonce `k` is derived deterministically from the private key and message, so `signDerivationMessage` is a pure function of `accountPrivKey` — no randomness anywhere in the `v2` chain after `generateDeviceSecret`.
- **`lowS: true`**: the signature's `s` is normalized to the lower half of `[0, n)`, matching Ethereum's canonical signature malleability rule.
- **No `extraEntropy`**: noble's `sign` supports optional auxiliary randomization of the nonce; `v2` explicitly disables it, because introducing any entropy here would break determinism (the same `deviceSecret` must always yield the same `sig64`, forever).
- The compact encoding is `r || s` (64 raw bytes, no recovery byte / `v`) — `sig.toCompactRawBytes()`.

`sig64` is the single piece of entropy that both the spending/viewing keys (§4.3) and the auth key (§5) are derived from; it is never itself persisted — it is recomputed from `accountPrivKey` (equivalently, from the device secret) whenever needed.

### 4.3 Spending and viewing keys — FluidKey compatibility contract

```
r = sig64[0..32]
s = sig64[32..64]
spendingPrivKey = keccak256(r)
viewingPrivKey  = keccak256(s)
```

This reproduces [FluidKey](https://www.fluidkey.com/)'s `generateKeysFromSignature` **byte-for-byte**: given the same signature, this package and FluidKey's own tooling derive identical spending and viewing private keys. Two properties of this step are deliberate deviations from §2's `hashToScalar` and must be preserved by any compliant implementation:

1. **No domain-separation tag.** Unlike the account and auth keys, `keccak256` here is applied directly to the raw signature half — no tag string is prepended. This is required for bit-for-bit compatibility with FluidKey's construction, which this package intentionally mirrors rather than reinvents.
2. **No reject-and-retry.** `keccak256(r)` / `keccak256(s)` are used as the private scalar directly, with no counter loop. The result is only _validated_ (via `scalarToKeypair` → `isValidScalar`) to lie in `[1, n)`; an out-of-range result — probability `~2^-128`, i.e. the same order of unreachability as `hashToScalar`'s counter exhaustion — throws `DerivationFailureError` rather than silently retrying with a different candidate. Retrying here would produce a value FluidKey's own (retry-free) tooling could never reproduce, defeating the entire point of this compatibility contract.

Cross-checking this construction against FluidKey's reference implementation (`@fluidkey/stealth-account-kit`, a dev dependency of this package) is part of this package's test suite, not merely a design note — see [§10](#10-conformance-vectors).

## 5. Auth key

```
authPrivKey = hashToScalar(DOMAIN_AUTH, sig64)
```

where `DOMAIN_AUTH = "coordination-network/identity/v1/auth"`. Unlike spending/viewing, the auth key _does_ go through the full `hashToScalar` reject-and-retry construction (§2) — it has no external compatibility contract to preserve, so it uses the scheme's standard primitive rather than a bespoke one.

## 6. `networkId` and `memberNetworkId`

```
networkId       = keccak256(utf8(DOMAIN_NETWORK_ID) || X || Y)    # users
memberNetworkId = keccak256(X || Y)                                # network members
```

where `DOMAIN_NETWORK_ID = "coordination-network/identity/v2/network-id"` and `X || Y` is the account's uncompressed public key **coordinates without the `0x04` SEC1 prefix** (i.e. the 64-byte raw `X || Y`, not the 65-byte `0x04 || X || Y` form). `computeNetworkId` and `computeMemberNetworkId` (`src/network-id.ts`) accept either the 65-byte prefixed or 64-byte raw encoding as input and strip the prefix themselves when present.

**Invariant:** the low 20 bytes (last 20 bytes) of `memberNetworkId` are exactly equal to the account's Ethereum address, because an Ethereum address is _defined_ as the low 20 bytes of `keccak256` of the same 64-byte uncompressed public key coordinates. `networkId` has no such property: its input carries the domain tag, so it is not linkable to the account address by anyone who does not already hold the account public key.

Members keep the plain hash because `NetworkMemberRegistry` derives a member's auth address from the low 20 bytes of its id, and a member's auth address is public anyway. Users get no benefit from that link, so their id does not carry it.

**Provenance of this construction:** hashing the bare 64-byte public key (not the compressed key, not the signature, not any other encoding) to get an identity commitment is the same convention used by [Semaphore](https://semaphore.pse.dev/)'s identity commitments and is exactly the serialization Ethereum itself uses to derive addresses — `memberNetworkId` reuses it verbatim rather than defining a new one, precisely so the "last 20 bytes = address" invariant holds for free. `networkId` prefixes the domain tag to the same bytes.

### 6.1 Erratum: the user integration spec's step-3 line

The user integration spec's prose description of this scheme has a step-3 line that says, in effect, "`networkId = keccak256` over the RFC-6979 derivation-message signature." **This is an error in that document, not an alternate valid construction.** The diagram in the same document, its data-structures section, and the network-id section itself all independently specify `keccak256` over the **account public key**, and that is what this package implements and what is normative.

Beyond the internal inconsistency, hashing the signature for `networkId` would additionally be actively hazardous: `sig64`'s two halves (`r`, `s`) are precisely the seeds for the spending and viewing private keys (§4.3). Any construction that publishes or otherwise makes `keccak256(sig64)` (or any function of `sig64` as a whole) discoverable narrows the search space around values that already double as private-key seed material, which is a poor property for a _public_, network-visible identifier to have. The pubkey-based construction has no such coupling: the account public key holds no secret, and hashing it introduces no new relationship to the spending/viewing secrets. Keeping that key off-chain is what keeps `networkId` unlinkable to the account address (§6).

## 7. Team decision: ECDSA only, no EdDSA

An earlier draft of this scheme (issue #17) reserved a slot for a Baby Jubjub EdDSA key, as one item of that issue's definition-of-done checklist. **On 2026-07-13 the team decided to drop it**: `v1` is all-ECDSA (secp256k1) — account, spending, viewing, and auth are the complete key set, and there is no EdDSA key anywhere in this scheme or this package. This is a deliberate deviation from issue #17's original DoD, not an oversight; any future EdDSA requirement would be introduced (if at all) as a new, explicitly versioned addition, not folded silently into `v1`.

#### Amendment, 2026-07-21: the Baby Jubjub key is reinstated

The 2026-07-13 record above is preserved verbatim, but it is no longer this document's final word: **on 2026-07-21 the team reversed that decision.** `packages/credential`'s privacy-preserving VC revocation scheme landed on `@semaphore-protocol/identity` v4, whose identity primitive **is** a Baby Jubjub EdDSA keypair, resurfacing the need for that curve at the identity layer. That seam is described in [specs/01-self-sovereign-user.md](../../specs/01-self-sovereign-user.md), §Baby Jubjub EdDSA key and Semaphore commitment.

The reinstated key is deliberately **not** a retraction of the 2026-07-13 decision's substance: the secp256k1 core (account, spending, viewing, auth, §3 to §5) is completely unchanged, byte-identical, and remains this scheme's root of trust. The identity key is instead exactly the kind of "new, explicitly versioned addition" the original 2026-07-13 note anticipated as the only acceptable path back to EdDSA:

- It is a **standalone** derivation, `deriveEddsaKeypair` (`src/eddsa.ts`), additive to `deriveKeys`/`DerivedKeys`, and the secp256k1 key bundle and its shape are untouched.
- Every existing secp256k1-core constant, formula, and key vector in `derivation-vectors.json` stays byte-identical; the identity key's own conformance vectors live in a **separate** file, `eddsa-vectors.json` (§10).
- It is a **stable, device-level identity key** — deterministically re-derivable, like the secp256k1 keys, but from the hardware-backed device agreement key rather than from `deviceSecret` itself (§12.1) — **not** the per-credential revocation secret `r` that `packages/credential` generates per credential (`generateRevocationSecret()`, `randomBytes(32)`). The two are unrelated: this key identifies the _device_ across the network; `r` is a one-off, random, per-credential value. Wiring the two together, if ever done, is an explicit future decision, not something this reinstatement implies.

See [§12](#12-baby-jubjub-identity-key-and-semaphore-commitment) for the normative formula.

## 8. Why keccak256, not SHA-256

Every hash in this document — `hashToScalar`, the EIP-191 digest, the spending/viewing keys, `networkId` — uses **keccak256**, not SHA-256, with one deliberate exception noted below. Reasons, in order of weight:

1. **EVM-native.** keccak256 is the hash the EVM itself uses (the `KECCAK256` opcode, Ethereum address derivation, event topics). A scheme whose identifiers are meant to be checked against on-chain addresses and consumed by Solidity contracts should use the hash those contracts already use natively, rather than requiring a second hash primitive on-chain purely to reconcile conventions.
2. **Ecosystem consistency.** [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) (stealth addresses) and FluidKey's own tooling — the two external constructions `v2` is directly compatible with (§4.3, §6) — already use keccak256 throughout. Using anything else would mean translating between hash families at every integration boundary for no benefit.
3. **Length-extension immunity.** Keccak (and so keccak256) is not vulnerable to the length-extension attacks that affect the plain Merkle–Damgård constructions in the SHA-2 family (SHA-256 included). This scheme does not rely on that property anywhere today, but it is a reason keccak256 is the safer default rather than merely the conventional one.

**The exception: `confirmationKeyHash` (§11.2).** It is the RFC 7638 JWK thumbprint, which fixes SHA-256. None of the three reasons above apply to it: it is never checked on-chain, it has no ERC-5564 or FluidKey counterpart, and it is a fixed-length input so length extension is moot. The credential layer commits to the same P-256 key a second time, as a Poseidon value in the credential's claim tree, because a zero-knowledge circuit has to recompute it. That commitment is a separate value, specified in [VC Issuance and Verification](../../specs/03-vc-issuance.md); `confirmationKeyHash` itself is unchanged.

## 9. Domain separation

| Constant               | Value                                           | Used by                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIXED_DOMAIN_MSG`     | `"coordination-network/identity/v1"`            | §4.1 — the message signed by the derivation-message signature.                                                                                                                                                                                                                                                 |
| `DOMAIN_ACCOUNT`       | `"coordination-network/identity/v1/account"`    | §3 — `hashToScalar` tag for the account key.                                                                                                                                                                                                                                                                   |
| `DOMAIN_AUTH`          | `"coordination-network/identity/v1/auth"`       | §5 — `hashToScalar` tag for the auth key.                                                                                                                                                                                                                                                                      |
| `DOMAIN_EDDSA`         | `"coordination-network/identity/v1/eddsa"`      | §12 — tag for the Baby Jubjub EdDSA seed (`eddsaSeed = keccak256(utf8(DOMAIN_EDDSA) \|\| ecdhSharedSecret)`), the identity key. Note this is a **plain keccak256 prefix**, not a `hashToScalar` reject-and-retry tag (§12 explains why no retry is needed here).                                               |
| `DOMAIN_EDDSA_PEER`    | `"coordination-network/identity/v1/eddsa/peer"` | §12.1 — the `msg` input to RFC 9380 hash-to-curve when computing the fixed NUMS peer point `Q`. Consumed solely by RFC 9380 hash-to-curve: `DOMAIN_EDDSA_PEER` is the only tag in this table that never passes through `keccak256` in any form.                                                                |
| `DOMAIN_NETWORK_ID`    | `"coordination-network/identity/v2/network-id"` | §6 — plain keccak256 prefix for a user's `networkId` (`networkId = keccak256(utf8(DOMAIN_NETWORK_ID) \|\| X \|\| Y)`). `memberNetworkId` uses no tag.                                                                                                                                                          |
| `BINDING_NONCE_LENGTH` | `32`                                            | §11 — required byte length of `nonce` and `networkId` in the credential-binding messages. A **length constraint**, not a domain-separation tag: it has no string value and is never itself hashed. §11.6 explains how a fixed length still provides domain separation, by construction rather than by content. |

Every tag is prefixed with the scheme name and the version that introduced its formula (`coordination-network/identity/v1`, `coordination-network/identity/v2`), so that even if two tags were (hypothetically) applied to the same input bytes, their hash outputs would still differ. Note that the spending/viewing keys (§4.3) intentionally do **not** go through a tagged domain — see the FluidKey-compatibility discussion there for why.

Tags are concatenated with no length prefix, so no tag hashed as `utf8(tag) || input` may be a prefix of another; `tests/keygen.test.ts` checks every keccak-prefixed `DOMAIN_*` constant. Two constants in the table do overlap others, harmlessly: `FIXED_DOMAIN_MSG` is hashed inside an EIP-191 frame, and `DOMAIN_EDDSA_PEER` goes only to RFC 9380 hash-to-curve.

### 9.1 Hash-to-scalar reject-and-retry, restated

For clarity, since this term recurs throughout this document: "hash-to-scalar reject-and-retry" refers specifically to the §2 construction — append an incrementing single-byte counter (`0..255`) to the hash input and take the first output that lands in `[1, n)`. It is used for the account key and the auth key. It is explicitly **not** used for the spending/viewing keys, which instead use direct, retry-free hashing with post-hoc range validation only (§4.3).

### 9.2 Versioning policy

Every constant in this document (`KEY_DERIVATION_VERSION`, `FIXED_DOMAIN_MSG`, `DOMAIN_ACCOUNT`, `DOMAIN_AUTH`, `DOMAIN_NETWORK_ID`) — and every formula that consumes them — is **frozen** for as long as `KEY_DERIVATION_VERSION = "v2"`. None of them may change silently: a silent change would make every device secret already in the field derive different keys than before, without any way to detect that it happened. Any change to any formula or constant in this document — including ones that look purely cosmetic — **must** ship as a new derivation scheme version (a new `KEY_DERIVATION_VERSION` string and, where the change affects them, new domain tags), never as an in-place edit to `v2`'s behavior.

A domain tag carries the revision that introduced its formula, not the current `KEY_DERIVATION_VERSION`. A revision that leaves a formula alone leaves its tag alone, which is why the key tags stay `/v1/` while `KEY_DERIVATION_VERSION` is `v2`: those keys are unchanged.

## 10. Conformance vectors

`tests/vectors/derivation-vectors.json` is the conformance test vector file for this scheme: known `deviceSecret` inputs paired with every intermediate and final value defined in this document (`accountPrivKey`, `sig64`, `spendingPrivKey`, `viewingPrivKey`, `authPrivKey`, `networkId`, `memberNetworkId`, and the full `DerivedKeys` bundle). Any reimplementation of `v2` — in this package's own test suite or in a different language/runtime — should reproduce every value in that file exactly. It is the executable counterpart to this document: where prose and vectors could ever be read to disagree, the vectors (checked against this package's own source, which is itself the reference implementation) are what a compliant implementation is actually graded against.

`tests/vectors/binding-vectors.json` is the analogous conformance vector file for the credential-binding scheme (§11): it reuses the first six `deviceSecret` values from `derivation-vectors.json`, paired with deterministic seeded nonces and P-256 test keys, and pins every intermediate and final value §11 defines (`confirmationKeyHash`, both message layouts, the `sig_A` digest, `sig_A`, and `sig_B`). Each vector's `holderKeyCommitment` is the matching `eddsa-vectors.json` commitment; its `requestCommitment` is an opaque seeded value, since this package never computes the real one. See §11's own note on why `sig_B` in these vectors is a deterministic test signature rather than a randomized platform one.

`tests/vectors/eddsa-vectors.json` is the conformance vector file for the Baby Jubjub identity key (§12): twelve seeded **test** P-256 keys stand in for the hardware key `hwPriv` (indices 0–5 deliberately coincide with the `hwPriv`/`confirmationKey` values in `binding-vectors.json` — a deliberate reuse, not a mistake, mirroring §11's own note on why `sig_B` in those vectors is a deterministic test signature rather than a randomized platform one), paired with `hardwarePrivateKey`, `hardwarePublicKey`, `ecdhSharedSecret`, `eddsaSeed`, `secretScalar`, `publicKey` (`[x, y]`), and `commitment` — the bigint fields encoded as decimal strings, since JSON has no native bigint type. `tests/eddsa-vectors.test.ts` replays both legs of the pipeline: it recomputes `ecdhSharedSecret` from `hardwarePrivateKey` in software (noble `p256.getSharedSecret` against the pinned peer point `Q`), pinning the ECDH leg, then feeds that value to `deriveEddsaKeypair` to reproduce every remaining field. `tests/semaphore-crosscheck.test.ts` additionally cross-checks every vector's `ecdhSharedSecret` (plus further seeded secrets) against `@semaphore-protocol/identity` directly, which is the stronger of the two guarantees — see §12's interop-contract note.

## 11. Credential-binding messages (dual proof-of-possession)

Credential issuance binds two keys to one issuance session: the device's own secp256k1 **account key** (§3, "A") and a hardware-backed P-256 **confirmation key** ("B" — Secure Enclave, Android Keystore, or WebCrypto). Each key signs a message naming the same session `nonce` and the same `networkId` (§6); the device message also commits to the holder key and to the issuance request, so an issuer that receives both signatures can be certain they were produced by the same device for the same session — a device signature cannot be lifted from one session and paired with an unrelated account signature (§11.5). This is implemented in `src/binding.ts` and `src/confirmation-key.ts`.

### 11.1 Message layouts

```
deviceBindingMessage  = nonce(32) || networkId(32) || holderKeyCommitment(32) || requestCommitment(32) # 128 bytes, signed by B (P-256)
accountBindingMessage = nonce(32) || confirmationKeyHash(32) || networkId(32)                         #  96 bytes, signed by A (secp256k1)
```

Strict spec-literal concatenation: neither message carries a domain-separation prefix. `nonce`, `networkId`, `holderKeyCommitment` and `requestCommitment` MUST each be exactly 32 bytes (`BINDING_NONCE_LENGTH` for the first two) — see §11.6 for why the fixed lengths matter beyond mere tidiness.

`holderKeyCommitment` is the 32-byte big-endian encoding of the identity key's Semaphore commitment (§12). `requestCommitment` is opaque to this package: it commits the device signature to the issuer and the scope the user consented to, so the signature cannot be replayed to another issuer or for another scope. The credential layer defines its preimage, in [specs/03-vc-issuance.md](../../specs/03-vc-issuance.md), and implements it as `issuanceRequestCommitment` in `@coordination-network/credential`.

### 11.2 `confirmationKeyHash`

```
confirmationKeyHash = sha256(utf8(`{"crv":"P-256","kty":"EC","x":"<base64url Xp256>","y":"<base64url Yp256>"}`))
```

the RFC 7638 JWK thumbprint of the confirmation key: SHA-256 over the four required members of an EC JWK, in lexicographic order, with no whitespace and unpadded base64url coordinates. `Xp256` and `Yp256` are the key's raw 32-byte coordinates with any SEC1 prefix stripped. This is the one place the scheme leaves keccak256 (§8). `normalizeConfirmationKey` (`src/confirmation-key.ts`) accepts three input encodings — 65-byte SEC1 uncompressed, 33-byte SEC1 compressed, and 64-byte raw `X || Y` (a superset of the two encodings §6's `computeNetworkId` accepts: the binding module additionally takes the compressed form, since it must consume keys from platform APIs it does not control) — and validates the point is on the P-256 curve before hashing.

> Amended 2026-08: `confirmationKeyHash` was `keccak256(Xp256 || Yp256)` until this change. It is now the RFC 7638 thumbprint. `KEY_DERIVATION_VERSION` is unchanged, because the binding scheme derives no keys, and §11.5 records the earlier PR #89 change to `sig_B` on the same basis. The committed vectors in `tests/vectors/binding-vectors.json` were regenerated; per §10 they, not this prose, are what an implementation is graded against.

### 11.3 `sig_A`

`sig_A` is produced and verified with exactly the construction §4.1–4.2 define for the derivation-message signature, applied to a different message:

```
digest = keccak256(utf8("\x19Ethereum Signed Message:\n" || decimal(len(accountBindingMessage))) || accountBindingMessage)
sig_A  = ECDSA-sign(digest, accountPrivKey)   # secp256k1, RFC-6979 deterministic, lowS: true, NO extraEntropy
```

`len(accountBindingMessage)` is always `96` (the account message's fixed byte length, computed rather than hardcoded), so the EIP-191 prefix is `"\x19Ethereum Signed Message:\n96"`. Determinism, `lowS: true`, and no `extraEntropy` all carry over unchanged from §4.2's rationale — the same `nonce`/`confirmationKey`/`networkId` triple always yields the same `sig_A`. Unlike the derivation-message signature (§4.2), `sig_A` is not itself a further entropy source for other keys; it exists purely as a proof the issuer verifies.

### 11.4 `sig_B`

`sig_B` is produced by the hardware confirmation key over the raw `deviceBindingMessage` bytes: ECDSA-P256-SHA256 — `p256.sign(message, ..., { prehash: true })` in `@noble/curves` terms, or equivalently `SecKeyCreateSignature`, `Signature.getInstance("SHA256withECDSA")`, or `crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ...)` on the respective platforms. This package never signs with the P-256 key, and never performs key agreement with it either — the private key is expected to remain inside the secure element for both operations; the library only verifies signatures and only consumes an already-computed ECDH shared secret (§12.1) as opaque input bytes:

```
p256.verify(sig, deviceBindingMessage, confirmationKey, { prehash: true, lowS: false })
```

Two acceptance rules follow from what real platforms actually emit:

- **Encoding.** `verifyDeviceBindingSignature` accepts a 64-byte compact `r || s` (what WebCrypto produces) or a DER-encoded signature (what Secure Enclave and Android Keystore produce), detected by length (64 bytes → compact) or, otherwise, a leading `0x30` DER `SEQUENCE` tag.
- **`lowS` is deliberately not enforced.** Hardware P-256 signers are randomized (not RFC-6979 deterministic) and do not s-normalize their output. Rejecting a valid high-`s` hardware signature would be a false negative with no security benefit: `sig_B` is a one-shot liveness proof consumed once by the issuer, not a value whose malleability could be replayed into a different context — contrast secp256k1's `lowS: true` in §11.3, which matters because the account signature is verified against Ethereum's own canonical-signature convention.

**Why confirmation key B is not the identity key's hardware root (§12.1).** Confirmation key B is the device signing key: a non-exportable P-256 key generated with `PURPOSE_SIGN` only, which needs the user (biometric, or device PIN, pattern or password) for every single use. The ECDH that roots the identity key (§12.1) runs on a second non-exportable P-256 key, the device agreement key, generated with `PURPOSE_AGREE_KEY` only, which needs user authentication within a 10-second window. The keys are separate because per-use user authentication on Android needs a BiometricPrompt CryptoObject per operation, and a KeyAgreement CryptoObject is available only from Android 16 QPR2, so one key cannot be both per-use and usable for ECDH on Android 12 and newer. The ECDH peer is never attacker- or issuer-chosen: it is always the fixed, pinned NUMS point `Q` (§12.1). Both keys require a secure lock screen, and removing it invalidates both. The platform layer then makes new keys, the identity key changes (§12.1), and credentials bound to the old B must be re-issued. The secp256k1 core and `networkId` are unaffected, since they derive from `deviceSecret`.

### 11.5 Mutual binding and the locally-derived-`networkId` MUST

`verifyCredentialBinding` derives a single `networkId` from the account public key it is given, then checks both `sig_A` (against `accountBindingMessage`) and `sig_B` (against `deviceBindingMessage`) against messages built from that one value. A device signature naming a different session's `networkId` cannot be paired with this account's signature and pass, in either direction. This mutual-binding property is the change spec commit `617696e` ("update sign_B as bi-directional", PR #89) makes to the scheme's previous, one-directional shape, in which `sig_B` signed only `nonce` and carried no `networkId` at all.

**MUST (normative):** the device signs the `networkId` it derives **locally**, from its own account key — never a `networkId` supplied to it by a counterparty in the issuance request. This is the invariant `verifyCredentialBinding`'s mutual check depends on to mean anything: if a device would sign whatever `networkId` an issuance request handed it, `sig_B` would prove nothing about which session actually produced it. See [specs/01-self-sovereign-user.md](../../specs/01-self-sovereign-user.md), §Identity & Key Derivation, and [specs/02-wallet.md](../../specs/02-wallet.md) for the wallet- and issuer-facing statement of this requirement.

Every function in `src/binding.ts` except the two low-level spec-literal builders (`buildDeviceBindingMessage`, `buildAccountBindingMessage`) and `verifyDeviceBindingSignature` enforces this structurally rather than leaving it as a caller obligation: `networkId` is derived internally via `computeNetworkId` and is never accepted as a parameter, so a caller cannot supply the wrong value even by mistake. `verifyDeviceBindingSignature` is the one exception, because it cannot derive `networkId` itself — `sig_B` is verified independently of the secp256k1 account key — which is why callers assembling the full dual-PoP check should prefer `verifyCredentialBinding` over calling it directly.

### 11.6 Injectivity of the two message types

`deviceBindingMessage` is always exactly 128 bytes; `accountBindingMessage` is always exactly 96 bytes. Because every field of both is fixed at exactly 32 bytes — never variable-length — the two message types can never collide: no 128-byte device message is ever also a valid 96-byte account message (or vice versa), and no byte sequence produced as one message type can be validly reinterpreted as the other. This is domain separation by fixed length rather than by tagged content — a different mechanism from §9's `hashToScalar` domain tags, but serving the same purpose: making sure a value computed for one role can never be mistaken for a value computed for a different one.

### 11.7 Future hardening (non-normative): P-256 cross-context domain separation

The `v2` binding messages, as specified, embed no P-256-specific domain-separation prefix — `sig_B`'s message is exactly the four concatenated fields of §11.1, with nothing marking it as belonging to this protocol rather than some other P-256-signing context that happened to reuse the same 128-byte layout. The only tag is the one inside `requestCommitment`'s hash, which scopes that field to issuance requests, not the message as a whole. A future version could prepend a fixed context tag (analogous to `FIXED_DOMAIN_MSG`, §9) to `deviceBindingMessage` before hashing/signing, at the cost of no longer being able to verify a _raw_ platform signature over exactly those fields without that prefix. This is recorded here as a design note for a future version, not a requirement of `v2`: the current scheme's injectivity argument (§11.6) already rules out cross-message-type confusion within this protocol, and no cross-protocol P-256 signing context is known today that a `sig_B` could plausibly be confused with.

## 12. Baby Jubjub identity key and Semaphore commitment

This section is normative, and reinstates what §7 originally removed — see §7's 2026-07-21 amendment for why. Everything else in this document (§1 to §11, the secp256k1 core, `networkId`, the credential-binding messages) is unaffected: this key is an **additive**, standalone derivation, not a modification of any of it.

### 12.1 The formula

```
DOMAIN_EDDSA      = "coordination-network/identity/v1/eddsa"
DOMAIN_EDDSA_PEER = "coordination-network/identity/v1/eddsa/peer"

Q = hashToCurve(utf8(DOMAIN_EDDSA_PEER))    # RFC 9380, P256_XMD:SHA-256_SSWU_RO_, suite-default DST
  = 0x045db1cabf31539848bf802ad49a94ad8f8e3d52e75bb53aa4552d7cf836eba054213badca0cf4ba6daf8c146d3415d9ae1905440781dc5f08e6e946a471af99e9

ecdhSharedSecret = X(hwPriv · Q)            # 32 big-endian bytes — Android Keystore KeyAgreement("ECDH") output,
                                             # equivalently noble p256.getSharedSecret(hwPriv, Q, true).slice(1)

eddsaSeed    = keccak256(utf8(DOMAIN_EDDSA) || ecdhSharedSecret)   # 32 raw bytes
secretScalar = deriveSecretScalar(eddsaSeed)                       # zk-kit: blake512 → prune → LE → mod l
publicKey    = derivePublicKey(eddsaSeed)                          # secretScalar · Base8 → [x, y]
commitment   = poseidon2([publicKey[0], publicKey[1]])             # Semaphore v4 identity commitment
```

Paymaster sponsorship uses a separate Baby Jubjub identity from the same `ecdhSharedSecret`:
`paymasterSeed = keccak256(utf8("coordination-network/identity/v1/paymaster") || ecdhSharedSecret)`.
`derivePaymasterKeypair` applies the same scalar, public-key and commitment steps to that seed.
Only its commitment may be added to the public paymaster group; the credential's
`holderKeyCommitment` remains private and must never be used as a group leaf.

`Q` is the exported constant `EDDSA_PEER_POINT_HEX` (`src/eddsa-peer.ts`) — a 65-byte SEC1 uncompressed P-256 point, pinned above and reproduced by `computeEddsaPeerPoint()` (which recomputes `hashToCurve(utf8ToBytes(DOMAIN_EDDSA_PEER))` at runtime as reproducibility evidence that the pin is not hand-picked); `eddsaPeerPointBytes()` returns a fresh copy of the same 65 bytes on every call. `hwPriv` is the private key of the hardware-backed P-256 **device agreement key** — a key generated for key agreement only, separate from the confirmation key ("B", the device signing key) that produces `sig_B` in §11 — and `X(...)` is the shared secret's x-coordinate, exactly what a platform ECDH primitive returns. This section replaces `v1`'s original formula (`eddsaSeed = keccak256(utf8(DOMAIN_EDDSA) || deviceSecret)`) in place, without a scheme version bump: `DOMAIN_EDDSA` is unchanged, but it now tags `ecdhSharedSecret` rather than `deviceSecret`. Five things follow from this construction:

1. **Hardware rooting.** `hwPriv` never leaves the secure element — it is generated non-exportable, with `PURPOSE_AGREE_KEY` only (Android Keystore terms; the analogous non-exportable, agreement-only configuration applies on any platform this scheme is ported to). Computing `ecdhSharedSecret` therefore requires the specific piece of hardware that holds `hwPriv` — the identity key cannot be recomputed by software alone, unlike the secp256k1 core (§1), which is a pure function of `deviceSecret`.
2. **Why `Q` must be a NUMS point.** ECDH is symmetric: anyone who knows the discrete log of `Q` could compute `hwPriv · Q` themselves, given `hwPriv`'s public counterpart, without ever touching the secure element — the hardware rooting in (1) would be worthless. `Q` is instead derived via RFC 9380 hash-to-curve from a fixed, published tag with no chosen input, so nobody — including whoever picked `DOMAIN_EDDSA_PEER` — knows or controls `dlog(Q)`. This is what makes `ecdhSharedSecret` computable only inside a device that actually holds `hwPriv`.
3. **Why ECDH, not another hardware signature.** Hardware ECDSA-P256 signing (`sig_B`, §11.4) is randomized, not RFC-6979 deterministic — the same message signed twice yields two different signatures — so it cannot serve as a deterministic seed. ECDH key agreement against a fixed peer point is the one deterministic operation a non-exportable hardware key can perform: the same `(hwPriv, Q)` pair always yields the same `ecdhSharedSecret`.
4. **Layering.** This package never talks to a keystore and never computes `hwPriv · Q` itself — `deriveEddsaKeypair` (`src/eddsa.ts`) takes `ecdhSharedSecret` as an opaque 32-byte input, computed by the platform layer (Android Keystore `KeyAgreement("ECDH")`, or equivalent) and handed in. `normalizeEcdhSharedSecret` (`src/bytes.ts`) validates it is exactly 32 bytes, delegating to the same check `normalizeDeviceSecret` performs but throwing `InvalidEcdhSecretError` (not `InvalidDeviceSecretError`, which would mischaracterize the input) on failure.
5. **MUST (normative), unrecoverability.** The identity key is **not** re-derivable from `deviceSecret` alone, and this is deliberate, not an oversight: losing access to the device agreement key (device reset, Keystore wipe, lost secure-element keys, removal of the secure lock screen, replaced secure element) permanently loses the ability to recompute this device's Semaphore commitment, even with `deviceSecret` still in hand. A new device agreement key derives a new, unrelated identity key. This is an accepted trade-off of hardware-rooting the key at all — see §7's amendment for why this key exists, and note that the secp256k1 core and `networkId` are unaffected: those remain fully recoverable from `deviceSecret` alone.

`deriveEddsaKeypair` (`src/eddsa.ts`) is the sole implementation of this formula. It performs the `keccak256` step itself and then delegates `secretScalar`/`publicKey`/`commitment` entirely to `@zk-kit/eddsa-poseidon` (`deriveSecretScalar`, `derivePublicKey`) and `poseidon-lite` (`poseidon2`) — this package contains **no EdDSA or Baby Jubjub cryptography of its own**, and no ECDH cryptography of its own either.

### 12.2 `deriveSecretScalar` and `derivePublicKey`, spelled out

These two functions are external to this package (they live in `@zk-kit/eddsa-poseidon`), but because this document aims to be reimplementation-grade, their algorithm is restated here rather than left as an opaque dependency:

```
h        = blake512(eddsaSeed)                # 64-byte hash, NOT keccak/SHA
b        = h[0..32]                           # lower 32 bytes only
b[0]    &= 0xF8                               # clear the low 3 bits
b[31]   &= 0x7F                               # clear the high bit
b[31]   |= 0x40                               # set the second-highest bit
s        = LE(b)                              # interpret b as a little-endian integer
secretScalar = (s >> 3) mod l                  # l = the Baby Jubjub subgroup order (`subOrder`)

publicKey = secretScalar · Base8                # scalar multiplication on Baby Jubjub, Base8 the standard generator
```

The `>> 3` (right-shift by 3 bits) is applied _before_ the `mod l` reduction, not after — this order matters because `subOrder` is not a multiple of 8, so shifting after reducing would not, in general, produce the same value. The low 3 bits are cleared by `b[0] &= 0xF8` so that the subsequent `>> 3` discards only already-zeroed bits (it is exact, losing no entropy). Note the difference from stock Ed25519/RFC 8032 §5.1.5 clamping, where the cleared low bits are _kept_ so the scalar stays a multiple of the curve's cofactor: here zk-kit shifts those bits out, dividing the cofactor back out, so `secretScalar = floor(LE(b) / 8) mod l` — the bare subgroup scalar, **not** a cofactor multiple.

This is the standard Ed25519-style RFC 8032 §5.1.5 clamping/pruning recipe (steps 1–3), applied with `blake512` in place of SHA-512 and the Baby Jubjub curve in place of Curve25519 — `deriveSecretScalar`'s own doc comment notes it deliberately skips RFC 8032's later steps (which fold in a nonce/message) because this package only needs the scalar, not a full signature. **`l` (`subOrder`) is the Baby Jubjub **subgroup** order, not the full curve order `order`** — `deriveSecretScalar`/`derivePublicKey` reduce and scale against the subgroup, matching Semaphore's own convention; get this wrong (e.g. reduce mod `order` instead) and every derived `publicKey`/`commitment` silently disagrees with Semaphore's.

### 12.3 Why no reject-and-retry

Unlike `hashToScalar` (§2, used for the account and auth keys), there is **no counter loop and no notion of an out-of-range candidate** here. The clamping in §12.2 is unconditional: every 32-byte hash output, after the fixed bit-clear/bit-set operations and the `mod l` reduction, is by construction a valid Baby Jubjub scalar in `[0, l)`. There is nothing to reject, so — unlike §4.3's spending/viewing keys, which validate-then-throw on out-of-range output — there is not even a validation step to fail. Every 32-byte `eddsaSeed` is unconditionally a valid EdDSA seed.

### 12.4 The raw-bytes MUST, and the hex footgun

**MUST (normative):** `eddsaSeed` MUST be passed to `deriveSecretScalar`/`derivePublicKey` (and to `@semaphore-protocol/identity`'s `Identity` constructor) as **raw bytes** — a `Uint8Array`/`Buffer` of the 32 seed bytes — never as a `0x`-prefixed (or bare) hex **string**.

This is not a stylistic preference: `@zk-kit/eddsa-poseidon` and `@semaphore-protocol/identity` accept `Buffer | Uint8Array | string` for exactly this input, and when given a `string` they treat it as **raw UTF-8 text**, not as hex to be decoded — a 64-character hex string is hashed as those 64 ASCII characters, not as the 32 bytes it represents. `new Identity(eddsaSeedHex)` and `new Identity(hexToBytes(eddsaSeedHex))` therefore derive two completely different, unrelated keys, and neither construction throws — the mistake is silent. `EddsaKeypair.seed` (`src/types.ts`) is typed and documented as `Hex` precisely to flag this: it is the seed's storage/transport encoding, and any code that needs to _use_ it (re-deriving via `deriveEddsaKeypair`'s own internals, or constructing a Semaphore `Identity` from it directly) MUST decode it back to raw bytes first (`hexToBytes`). `tests/semaphore-crosscheck.test.ts`'s hex-footgun regression pins exactly this failure mode — mirroring an equivalent regression fixed in PR#96's own Semaphore usage in `packages/credential`.

### 12.5 The Semaphore interop contract

The entire point of using `@zk-kit/eddsa-poseidon`/`poseidon-lite` rather than a bespoke construction is that `deriveEddsaKeypair(ecdhSharedSecret).commitment` is **byte-identical** to `new Identity(hexToBytes(deriveEddsaKeypair(ecdhSharedSecret).seed)).commitment` — i.e. this package's identity key and `@semaphore-protocol/identity`'s notion of an identity are, given the same raw seed bytes, the same identity. `tests/semaphore-crosscheck.test.ts` asserts this directly (`secretScalar`, both `publicKey` coordinates, and `commitment`), plus `Identity.import(id.export())` round-tripping and `Identity.verifySignature` over a `signMessage`-produced signature. This is the strongest correctness guarantee in this document for that key: unlike `tests/eddsa-vectors.test.ts` (which only proves this package reproduces its own prior output), the Semaphore cross-check proves this package's _usage_ of the underlying library matches what the library's own consumers (Semaphore) expect.

### 12.6 Dependencies, exact-pinned

`@zk-kit/eddsa-poseidon@1.0.4` and `poseidon-lite@0.3.0` (both runtime dependencies of this package) are pinned to the **exact** versions `@semaphore-protocol/identity@4.14.5` (a devDependency here, used only for the cross-check) itself depends on. This is deliberate, not incidental: with matching exact versions, Yarn dedupes all three packages' dependency graphs to a single copy of `@zk-kit/eddsa-poseidon` and `poseidon-lite` in `node_modules`, so `deriveEddsaKeypair` and `new Identity(...)` run the literal same code, not merely semver-compatible code that happens to agree today. **Any future bump of either pin MUST be done in lockstep with whatever `@semaphore-protocol/identity` version is current, and MUST keep `tests/semaphore-crosscheck.test.ts` green** — that test is the guard against the two silently drifting apart.
