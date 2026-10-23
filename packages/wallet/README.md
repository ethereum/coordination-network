# `@coordination-network/wallet`

The holder-side SDK for device keys, ZK credentials, consent-gated presentations,
and local issuer/revocation state.

The wallet verifies a credential's issuer signature and its holder, device, and
revocation-secret bindings before storing it. Before presenting, it requires
fresh approved-issuer and revocation trees, asks for consent, builds the private
circuit inputs, and delegates proof generation to the configured proof system.
It refuses a verifier-supplied `currentTime` more than 300 seconds from the
holder's clock before consent, signing, or proving, so a verifier cannot search
the credential's validity window by choosing arbitrary times.

## Use

```ts
import { ZkCredentialProofSystem } from "@coordination-network/credential"
import { Wallet } from "@coordination-network/wallet"

const proofGenerator = await ZkCredentialProofSystem.create(circuit)

const wallet = new Wallet({
    identitySeed, // raw 32-byte Semaphore identity seed
    deviceSigner, // hardware-backed P-256 signer on device
    consent: async (request) => showConsentSheet(request),
    loadChainState: async () => {
        // Rebuild both public trees and pin their roots to authoritative chain state.
        return {
            approvedIssuers,
            approvedIssuerRoot,
            revocations,
            revocationRoot
        }
    },
    proofGenerator,
    store // use a keystore-backed Store on device; MemoryStore is the default
})

await wallet.addCredential({
    id: credentialId,
    credential, // the issuer's response, unparsed; addCredential parses and verifies it
    revocationSecret
})

const stopSync = wallet.startRevocationSync()

const proof = await wallet.present(
    credentialId,
    {
        challenge,
        audience: verifierUrn,
        currentTime,
        programme: "demo-programme",
        country: "ZZZ"
    },
    // The state this credential is judged and proved against: lists from the server the caller
    // names, roots from chain.
    loadChainStateForPresentation
)

stopSync()
await proofGenerator.destroy()
```

`loadChainState` returns each reconstructed tree alongside its authoritative
root. The caller must read the roots from chain, not from the server that
served the lists: a root served beside its own list always matches it. The
wallet rejects a tree that does not hash to its root before storing or
presenting a credential. It uses the validated local trees to check every held
credential without revealing to an RPC provider which credential it owns.

The lists come from whichever server the caller names and the roots from chain.
`syncCredential(id, load)` refreshes one credential against a `load`, and
`present(id, request, load)` takes the same kind of `load` so that the proof
and the checks before it come from one read.
`syncRevocations`/`startRevocationSync` refresh every held credential against
the single `loadChainState` configured on the wallet, for background use.

## Rules enforced

- Invalid, unapproved, revoked, not-yet-valid, or expired credentials are not
  stored.
- A presentation proves membership against the whole approved set, so the
  proof's issuer root is the set's root and names no issuer. One network-wide
  revocation registry lets the verifier check the revocation root without
  picking a registry. Membership is checked beforehand, against the state the
  presentation itself loaded.
- A presentation restamps the credential from its own `load` before judging it,
  so it never proves against state an earlier sync left behind. Background sync
  runs every 30 seconds by default.
- Consent is requested only after all local eligibility checks pass. Holder and
  device signatures, and proof generation, happen only after consent succeeds.
- A `Store` receives the credential under `vc:<id>`, its revocation secret
  under `revsec:<id>`, and account keys under `key:<networkId>`. Secrets must
  go to secure storage; a caller can route by the exported `KEY_PREFIX`,
  `CREDENTIAL_PREFIX`, and `REVOCATION_SECRET_PREFIX`.
- `createFromSeed` accepts high-entropy bytes, not a human-memorable password.

Expected failures throw `WalletError` with a stable `code`, such as `REVOKED`,
`EXPIRED`, or `CONSENT_DENIED`. A failure to fetch public state uses
`CHAIN_STATE_UNAVAILABLE`, allowing callers to retry without treating the
credential as invalid. Failures while constructing presentation inputs use
`PRESENTATION_FAILED`.

## Tests

The suite proves against the circuit published by
`@coordination-network/zk-artifacts`, so it needs no local Noir toolchain:

```sh
yarn workspace @coordination-network/wallet test --runInBand --watchman=false
```

The end-to-end test uses the real Noir circuit and Barretenberg backend to
issue, store, present, and verify a credential, then refreshes the revocation
tree and confirms the wallet blocks another presentation.
