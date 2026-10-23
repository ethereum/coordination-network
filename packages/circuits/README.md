# Credential circuit

The circuit proves that an anonymous approved issuer signed a private,
version-one credential; the credential is valid for the required programme and
country; the presenter controls its bound hardware, holder and revocation keys;
and its revocation commitment is absent from a LeanIMT+ root returned by the
proof.

## Signed body

The credential is the private `Credential` type in `src/types.nr`. The issuer
signs its fixed, versioned commitment:

```text
policy = Poseidon4(
  programme_hash,
  country_code,
  not_before,
  expires_at
)

keys = Poseidon3(
  device_key_commitment,
  holder_key_commitment,
  revocation_commitment
)

Poseidon3(
  credential_domain,
  policy,
  keys
)
```

The circuit reconstructs this commitment and verifies the issuer's Baby Jubjub
EdDSA signature. It hashes the same private issuer key into a private binary
Merkle path with ZK-Kit's `binary-merkle-root` package and returns the resulting
root publicly, so the verifier can check it against the trusted on-chain
approved-issuer registry without learning which issuer signed.

The hardware P-256 key, Baby Jubjub holder key and separate Baby Jubjub
revocation key all sign the private session message:

```text
Poseidon4(presentation_domain, challenge, audience, credential_commitment)
```

The P-256 signature consumes the canonical 32-byte big-endian encoding of that
field element as its message digest. It is encoded as compact `r || s` with
low-`s` normalization, as Noir's P-256 verifier requires. Its public key is
private and opens the signed `device_key_commitment`, so it does not become a
presentation identifier.

Public inputs are current time, challenge, audience, required programme and
required country. The circuit returns the proven approved-issuer and revocation
roots as public outputs. After proof verification, the application must check
both roots against their trusted on-chain registries.

## Constraints

1. Verify issuer EdDSA over the reconstructed credential commitment.
2. Prove the same private issuer key belongs to the approved-issuer root returned publicly, over a private depth witness capped at the circuit's maximum tree depth.
3. Check `not_before <= current_time <= expires_at`.
4. Check the private programme and country equal the public requirements.
5. Open the device-key commitment and verify its private P-256 session signature.
6. Open the holder-key commitment and verify its private EdDSA session signature.
7. Open the revocation commitment and verify its private EdDSA session signature.
8. Prove that commitment is absent from a private LeanIMT+ witness and return
   the resulting root publicly.

The issuer, holder and revocation signature checks rely on cofactored EdDSA
verification (the key is multiplied by 8).

The verifier is `src/eddsa.nr`, a copy of `noir-lang/eddsa` with one added
constraint. Upstream converts the Poseidon challenge with `noir-edwards`
v0.2.5's `ScalarField::<64>::from`, which takes its WNAF slices from an
unconstrained hint and only range-checks them below the field modulus, never
against the input. A prover could replace the challenge with one and verify
`S = 0, R8 = -8A` for any key. The local copy asserts that the slices
reconstruct the hash. A `noir-edwards` bump must re-check that conversion
before this copy is dropped or the dependency rebuilt.

The canonical empty revocation root is zero and requires a zeroed depth-zero
witness.

## Toolchain

The native toolchain is pinned, and the two halves must match: a circuit
compiled by one Noir release and proved by a barretenberg built for another
fails inside bb's deserializer with `Length is too large`.

```sh
noirup -v 1.0.0-beta.22
bbup -v 5.0.0
```

## Running

```sh
yarn fixtures
yarn test
yarn execute
yarn test:constraints
bb prove -b target/credential.json -w target/credential.gz -o target/proof --write_vk --verify
```

`generate-fixtures.ts` builds the deterministic circuit fixture directly. The
credential SDK reproduces the same commitments and builds this ABI through
`buildZkPresentationInputs`; the issuer-service end-to-end test proves and
verifies the resulting witness.

## What the npm package is for

This package publishes the Noir sources so the circuit behind a published proof
can be read, audited and rebuilt from the same inputs. It is not a Noir
dependency: the package is a `bin` crate, and nargo rejects a dependency on one.

## Published artifacts

`nargo compile` writes to `target/`, which is not published. The compiled
circuit and its verification key ship separately, in
[`@coordination-network/zk-artifacts`](../zk-artifacts). Regenerate them from
this circuit, and commit the result, with:

```sh
yarn sync:zk-artifacts
```

## Runtime proofs

The credential package exposes `ZkCredentialProofSystem`, plus one-shot
`generateZkPresentationProof` and `verifyZkPresentationProof` helpers. Callers
provide the trusted compiled circuit artifact, which
`@coordination-network/zk-artifacts` publishes as
`credential/circuit.json`. The verifier checks the proof, independently binds
all five public parameters to its expected time, challenge, audience, programme
and country, and returns both proven roots to the application for its on-chain
registry checks.

The JavaScript runtime versions are pinned to the native toolchain:
`@noir-lang/noir_js@1.0.0-beta.22` and `@aztec/bb.js@5.0.0`. A circuit upgrade
must update these versions and regenerate the artifacts together.

Nargo 1.0.0-beta.22 reports a Brillig coverage warning in `noir-edwards`
`dbl_internal`. The dependency constrains both returned coordinates, so this is
a compiler false positive in `noir-edwards` v0.2.5.
