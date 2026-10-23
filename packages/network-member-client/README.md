# @coordination-network/network-member-client

The two things a network-member app does: issue a UserApproval credential a wallet can present, and
deliver value to a recipient's stealth address by announcing it on chain. Both gate on the caller
being currently approved, checked against the chain rather than assumed from configuration.

Built on packages this repo already ships — `issueZkCredential` and the registry client
(`packages/credential`), `ApprovedIssuerSet` (`packages/issuer-set`), and the stealth-address and
announcement builders (`packages/identity`). This package composes them; it adds no new
cryptography of its own.

## Install

```bash
yarn add @coordination-network/network-member-client
```

## issueVC

Issues a UserApproval credential and, alongside it, the issuer's fresh Merkle path into the
approved-issuer set: the witness a holder's wallet needs to prove the issuer was approved when it
signed, without revealing which issuer.

```ts
import { issueVC } from "@coordination-network/network-member-client"

const { credential, issuerSetRoot, issuerMembershipWitness } = await issueVC(params, {
    signer,
    approval,
    issuerSetReader
})
```

`signer` and `approval` are `packages/credential`'s ports (`CredentialSigner`, `ApprovalResolver`);
`issuerSetReader` is `packages/issuer-set`'s `ContractLeafReader`. `params` is
`ZkCredentialIssueParams` from `packages/credential`, unchanged.

The witness goes stale the moment the approved-issuer set changes: a key published or retired
after issuance moves the root. `fetchIssuerMembershipWitness` is the same lookup on its own, for a
member server to re-serve a fresh witness to a wallet whose credential has outlived the root it
was issued against. `ApprovedIssuerSetClient` pins all reads of one rebuild to a single block and
must not serve two rebuilds at once, so a server handling concurrent requests should construct a
fresh reader per request.

```ts
import { fetchIssuerMembershipWitness } from "@coordination-network/network-member-client"

const { root, witness } = await fetchIssuerMembershipWitness({ issuerSetReader, issuerPublicKey })
```

An approved issuer whose signing key was never published to the set fails at `issueVC` with
`ISSUER_KEY_NOT_PUBLISHED` — a misconfiguration caught at issuance, not at the holder's first
presentation.

## deliverToStealth

Delivers value to a network member's recipient by resolving their registered identity to a
meta-stealth address and announcing a fresh stealth address for it, ERC-5564 style.

```ts
import { deliverToStealth } from "@coordination-network/network-member-client"

const { stealthAddress, announcement, txHash } = await deliverToStealth(
    { memberNetworkId, recipientNetworkId },
    { approval, identityReader, submitter }
)
```

`ERC5564Announcer.announce` is permissionless — anyone can call it — so "an unapproved member is
rejected" is not a rule the chain enforces on its own. This package enforces it client-side, and
first: `approval.isApprovedNetworkMember(memberNetworkId)` runs before any other port is touched,
so an unapproved caller never even reads the recipient's identity.

- `MEMBER_NOT_APPROVED` — the member is not currently approved.
- `RECIPIENT_NOT_REGISTERED` — the recipient's networkId has no identity on `IdentityRegistry`.
- `INVALID_META_STEALTH_ADDRESS` — the resolved identity doesn't decode to a valid meta-stealth
  address.

`txHash` is returned when the announce transaction is submitted, not when it lands. A dropped or
reverted transaction leaves no `Announcement` event for the recipient's indexer to find, so
confirm the transaction (viem's `waitForTransactionReceipt`, for example) before recording the
delivery as done.

`stealthAddress` and `announcement` are fresh on every call: `buildAnnouncement` draws a new
ephemeral key each time, so the same recipient gets a different, unlinkable address for every
delivery.

## submitRegistration

Submits a user's signed registration consent (`@coordination-network/user-client`'s
`RegistrationRequest`) to `IdentityRegistry`, as an approved network member. The user's EIP-712
signature is off-chain consent; the chain itself only checks the member's anonymous Semaphore
membership proof, so this is the check that stands between an arbitrary request and a spent proof.

```ts
import { submitRegistration } from "@coordination-network/network-member-client"

const result = await submitRegistration(request, { domain, identityReader, prover, writer })
```

`domain` and `identityReader` are the same `ChainDomain` and `IdentityReader` used elsewhere in
this package; `prover` and `writer` are new ports (`RegistrationProver`, `RegistrationWriter`), each
carrying a `registry` (`RegistryLocation`) naming the `IdentityRegistry` deployment it's bound to.
`identityReader` can optionally report the same thing through `registryAddress`.
`submitRegistration` checks all three against `domain` before anything else, including before
`request` is verified: this is a configuration guard over what the ports report about
themselves, not a check on the request, so a mismatch throws a plain `Error` rather than a coded
one — a member app that wires a port at the wrong registry fails loudly instead of proving or
writing against the wrong deployment. `request` itself is then verified against `domain` — it is
`domain`, not any port, that the user's own signature is pinned to, so a forged or mistargeted
request never reaches the registry.

- If the registry already holds an entry for the request's networkId, `submitRegistration` returns
  `{ status: "alreadyRegistered", networkId, metaStealthAddress, matchesRequest }` without
  generating a proof. `matchesRequest` is whether the stored entry equals the request's own
  `metaStealthAddress` — false means someone else's registration is occupying this networkId.
- Otherwise it proves membership and writes, returning `{ status: "submitted", networkId,
metaStealthAddress, txHash }`. As with `deliverToStealth`, `txHash` is the hash of the submitted
  transaction, not proof it landed — confirm it before treating the registration as done.
- Losing the race between the read above and the write (someone else registers the same networkId
  in between) also resolves to `alreadyRegistered`, re-read from the registry rather than trusted
  from the revert.

Error codes, beyond the two already listed under `deliverToStealth`:

- `INVALID_REGISTRATION_REQUEST` — the request failed `verifyRegistrationRequest` against `domain`.
- `REGISTRY_UNAVAILABLE` — a registry read or write failed for a reason other than a named revert.
- `GROUP_MIRROR_UNAVAILABLE` — the approved-member group could not be rebuilt, or its rebuilt root
  did not match the chain's.
- `MEMBER_NOT_IN_GROUP` — the member's own identity is not (or no longer) a member of the group.
- `REGISTRATION_REJECTED` — `IdentityRegistry` or Semaphore reverted for any other named reason; the
  thrown `RegistryRevertError`'s `errorName` carries which one.

The approved-member group is re-mirrored on every call, never cached: a stale mirror proves
membership against a root the chain may have moved past, and a proof against a root outside
Semaphore's recent-root window is rejected on submission anyway.

## Adapters

`adapters.ts` wires the ports above to viem, so a member app has one way to run this against a real
chain:

- Approval comes from `@coordination-network/credential`'s `NetworkMemberRegistryClient`, used
  as-is for both issuance and delivery.
- `IdentityRegistryClient` — `IdentityReader` over `IdentityRegistry.identity`.
- `ApprovedIssuerSetClient` — `ContractLeafReader` over `ApprovedIssuerSet`'s paging getters.
- `ERC5564AnnouncerClient` — `AnnouncementSubmitter` over `ERC5564Announcer.announce`, given a
  `WalletClient` already carrying its account and chain.
- `SemaphoreGroupClient` — `GroupMirror` over Semaphore's group events, replayed into a
  `@semaphore-protocol/core` `Group` and checked against `getMerkleTreeRoot` on every call.
  `fromBlock` should be the Semaphore deployment's own block. Each call makes one
  topic-filtered `eth_getLogs` per event type over `[fromBlock, toBlock]`, where `toBlock` is the
  block pinned at the start of that call. Range caps on hosted RPCs are the scaling limit here — a
  chunked or incremental mirror is a follow-up, not something this client does today.
- `SemaphoreRegistrationProver` — `RegistrationProver` that mirrors the group and generates the
  membership proof, given the member's own Semaphore `Identity` and where the registry lives.
- `IdentityRegistryWriter` — `RegistrationWriter` over `IdentityRegistry.registerIdentity`, given a
  `WalletClient` and the `RegistryLocation` it targets. Maps a named revert (`AlreadyRegistered`, a
  `Semaphore__*` error, ...) to `RegistryRevertError` rather than letting viem's raw error through.
  `submitRegistration`'s lost-race handling depends on that revert surfacing at the write call, which
  in turn depends on viem's own gas estimation — that only runs for a local account. A `WalletClient`
  backed by a JSON-RPC account (a browser wallet, for example) skips it, so `AlreadyRegistered`
  surfaces only once the transaction is mined, not at submission.

None of it is required. Every port is a plain interface, so an app can supply its own
implementation — a different chain library, a queued submitter — without touching `issueVC` or
`deliverToStealth`.

## What this package does not do

- **It holds no keys.** `signer`, `approval`, `identityReader`, `submitter`, `prover` and `writer`
  are ports the caller supplies. Issuing a credential, announcing a stealth address, or proving and
  submitting a registration happens with keys and clients this package never sees — including the
  member's own Semaphore identity, which lives inside whatever `RegistrationProver` the caller
  constructs.
- **It owns no RPC.** The functions take ports, not a client or an RPC URL. `adapters.ts` is one
  convenient wiring, not the only one; nothing here calls `createPublicClient` on its own.
- **It does not revoke.** `packages/credential`'s revocation registry and commitments are
  unrelated to this package's two flows.
- **It does not move assets.** `deliverToStealth` announces a stealth address; it transfers
  nothing. The ERC-1155 scoped-token machinery in
  [`specs/05-stealth-addresses.md`](../../specs/05-stealth-addresses.md) doesn't exist yet, and
  wiring it in is a separate change.
- **It is not `apps/issuer-service`.** That app still runs its own HTTP layer over pieces this
  package composes. Refactoring it onto `issueVC` is a follow-up issue, not part of this package.
