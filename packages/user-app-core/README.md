# `@coordination-network/user-app-core`

The three `@coordination-network/user-app-link` operations a user app serves —
`registration.sign`, `credential.issue`, `presentation.create` — implemented over injected device,
storage, HTTP and proving ports. One operation per flow, each behind one consent. Runs
unchanged on the Expo app (`expo-secure-store`, a native prover) and the browser app (IndexedDB,
`bb.js` in a Worker): every platform difference lives in the ports, not here.

This package holds no business logic. It holds keys, held credentials, and revocation secrets, and
serves any number of network member apps over the deep-link protocol.

## Use

```ts
import { createUserAppService } from "@coordination-network/user-app-core"
import { createRequestHandler } from "@coordination-network/user-app-link"

const service = createUserAppService({
    store, // Store from @coordination-network/wallet, e.g. expo-secure-store-backed
    deviceKey, // DeviceKey: signerFor(prompt), ecdh(peer, prompt), getPublicKeyJwk(), getSecurityLevel()
    proofGenerator, // ProofGenerator from @coordination-network/wallet
    http: { getJson, postJson },
    consent: async (summary) => showConsentScreen(summary),
    review: async (summary) => showShareScreen(summary),
    progress: (op, step) => showStep(op, step)
})

if (!(await service.isOnboarded())) {
    await service.createIdentity()
}

const handler = createRequestHandler({ handlers: service.handlers, consent: service.consent })
const responseUrl = await handler.handle(incomingUrl)
```

`service.consent` is the single gate `createRequestHandler` calls before dispatch; `Wallet`'s own
`ConsentPrompt` is wired to a constant `true` internally, so one deep link never shows two consent
screens. `presentation.create` asks once more through `review`, before it proves anything or asks
the device key to sign, so a refusal costs no key use and the question is about what the proof
reveals. Handler
bodies run one at a time — a second deep link arriving mid-sync waits for the first to finish
rather than interleaving with it.

`service.readIdentity()` is how the app's own Identity screen reads the identity. No operation
hands it over a link: a member app that wants a `networkId` asks for a signed registration request
and reads the one inside it.

## Ports

- `store` / `proofGenerator` — `@coordination-network/wallet`'s own interfaces, taken verbatim.
- `deviceKey: DeviceKey` — the holder's two P-256 hardware keys: `getPublicKeyJwk()` for the
  signing key, `signerFor(prompt)` for a `DeviceSigner` whose every signature raises `prompt`,
  `ecdh(peerPublicKey, prompt)` (the X coordinate of `agreementPriv · peerPublicKey`, 32 raw
  bytes — feeds `deriveEddsaKeypair`) and `getSecurityLevel()`, which reports the lower of the two
  keys' levels, and `getAttestationChain()`, the base64 DER key attestation chain of the signing
  key, leaf first, or `[]` when it has none. The `signerFor` signer is accepted as-is by `Wallet` and
  `buildZkPresentationInputs`. A cancelled prompt, an invalidated key or a failed authentication
  throws `DeviceKeyError`; a cancel reaches the caller as `CONSENT_DENIED`, the other two as
  `INTERNAL`. The identity seed is unlocked by one ECDH prompt the first time a process needs it,
  then cached until `erase()`, or until `removeUnboundCredentials()` removes something. Listing and
  `registration.sign` never touch a key. Issuance posts the chain as `deviceAttestation` (omitted
  when empty), and `createIdentity` refuses a level below `minimumDeviceSecurityLevel`.
- `minimumDeviceSecurityLevel?: SecurityLevel` — the lowest level `createIdentity` accepts. Absent
  means no floor; `UNKNOWN` ranks with `SOFTWARE`. The issuer enforces its own minimum on
  the attested level.
- `http: HttpClient` — `getJson`/`postJson`, each returning `{ status, body }`. Deliberately
  structural: no DOM or Node fetch types leak into either app, and a test fake is three lines.
- `directory: MemberDirectory` — `issuerKeyLeavesOf(networkId)`, the leaves of a member's live issuer
  keys from `ApprovedIssuerSet.issuerKeysOf`. `credential.issue` requires the signing key to be among
  them; a rejection means the chain could not be read, an unknown member (removed, or missing from
  the wallet's own member list) answers `[]`. An implementation must not reveal to the chain node
  which member is asked about.
- `roots: RootAuthority` — `currentRoots()`, the chain's current approved-issuer-set root and
  leaf count, and revocation root. `credential.issue` and `presentation.create` check the lists a
  server serves against these; a rejection means the chain could not be read (`CHAIN_UNREACHABLE`). An
  implementation must read the chain, never a server.
- `consent: UserConsentPrompt` — `(summary: ConsentSummary) => Promise<boolean>`. The summary is
  values, never prose: the caller, the rows a screen folds behind its technical toggle, and — on
  the two ops that scope one — the programme and country. The app writes the sentence, so it can
  name the caller mid-line in the caller's own colour. `ConsentSummary` is keyed by `op`, so a
  screen switching on it gets `scope` typed rather than optional. At prompt time no credential has
  been selected yet for `presentation.create`, so its summary names the verifier, programme and
  country rather than a credential — that is the material fact anyway.
- `review: PresentationReviewPrompt` — `(summary: PresentationReview) => Promise<boolean>`, asked
  after `presentation.create` has chosen a credential and before it proves or posts. The summary names the
  verifier, programme, country and the credential's issuer, so the person sees which credential
  answered; the proof itself no longer reveals the issuer. `false` refuses with `CONSENT_DENIED`.
- `progress: (op, step) => void` — named steps inside a long handler, for a screen that shows what
  the wallet is doing. `credential.issue` reports six; `presentation.create` reports three.
- `now?: () => number` — defaults to `Date.now`; inject it for deterministic tests.

## Honesty note

**Served lists are checked against the chain, not against the server.** The leaves from
`GET /v1/issuers` and the snapshot from `GET /v1/revocations/snapshot` are bulk data: the `root`
each also serves is never read. Both handlers read the chain's current roots through `roots`. The
lists must hash to them, and the issuer set must have the chain's leaf count: an internal node can
stand in for the leaves under it and keep the root, so the count is what fixes every leaf. A server
therefore cannot choose which root a holder proves against, nor learn which side of a cut an issuer
is on. A mismatch is `VERIFIER_UNREACHABLE` on `presentation.create` and
`ISSUER_UNREACHABLE` on `credential.issue`; roots that cannot be read are `CHAIN_UNREACHABLE`. There
is no retry and no root cache, so a wallet offline from the chain cannot present or issue. When a
list and the chain disagree, the person runs the request again.

## Store keys

`credential.issue` and `presentation.create` each construct a fresh `Wallet` over the same
persistent `store` `ports` supplies; `registration.sign` never needs one. `Wallet` owns the `key:`
and `vc:`-prefixed entries in that store; this package owns two prefixes of its own:

- `user-app-core:device-secret` — the one device secret this package ever holds (unlike `Wallet`'s
  own per-`networkId` key store, this package supports exactly one identity at a time).
- `user-app-core:issuer-index:<issuerNetworkId>` — what a credential body cannot give back: the
  issuer's `networkId` (the body carries its Baby Jubjub public key instead), the plaintext
  programme (the body carries a hash), the country, when this wallet stored it, and where that
  issuer publishes its approved-issuer set (`issuersUrl`). Written by `credential.issue`;
  read by `presentation.create` to match each credential to its issuer, by `listCredentials` to
  name the issuer, and by `credential.issue` itself to answer `alreadyHeld`.

The revocation secret is no longer stored between deep links: `credential.issue` generates it,
opens the credential with it and hands it to `Wallet` inside one call, so it never leaves that
function.

`removeUnboundCredentials()` compares each held credential's `deviceKeyCommitment` with the current
signing key and deletes the ones bound to another key, with their revocation secrets and issuer
index entries, then resolves to how many it removed. It reads only the public key, so it raises no
prompt, and keeps the device secret and every other key, so the person stays registered. Run it at
every start: a run cut short leaves the rest still unbound, and the next one removes them.

`erase()` deletes every key in `store`, not only this package's own three prefixes and `Wallet`'s —
a host app shares the same store for its own state (the user app keeps its stack descriptor there),
so a full wipe reaches that too. A caller that wants to survive `erase()` keeps its own state
elsewhere.

## Selecting a credential for `presentation.create`

`presentation.create`'s params carry no credential id. Held credentials are filtered to those whose
body matches the requested programme and country — no status filter — and each survivor is then
synced against the verifier's lists, which must hash to the chain's current roots. The one expiring latest among those still `valid` wins,
ties broken by id for determinism. None valid but one revoked throws `CREDENTIAL_REVOKED`; none at
all throws `NO_CREDENTIAL`. Both stay distinguishable from a `PROOF_FAILED` thrown once proving has
actually started.

## Tests

```sh
yarn test:library user-app-core --watchman=false
```

Real collaborators are used wherever they are pure: a real `Wallet` over a real `MemoryStore`, a
software P-256 `DeviceKey` (`LocalP256Signer` plus a plain ECDH that records its prompts), real `ApprovedIssuerSet` and
`RevocationRegistry`, and credentials issued with the real `issueZkCredential`. Only the proof
generator and the HTTP port are faked.

## License

MIT, see [`LICENSE`](./LICENSE).
