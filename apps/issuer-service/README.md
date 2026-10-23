# issuer-service

Demo issuer for the Coordination Network approval credential. The service
verifies the issuance proofs and returns a canonical credential whose complete
body is signed with Baby Jubjub EdDSA.

## Run

```sh
yarn build:libraries
RPC_URL=http://127.0.0.1:8545 \
REGISTRY_ADDRESS=0x... \
IDENTITY_REGISTRY_ADDRESS=0x... \
CHAIN_ID=31337 \
ISSUANCE_PROGRAMME=demo-programme \
ISSUANCE_COUNTRY=ZZZ \
MEMBER_SERVER_TOKEN=a-local-member-token \
ALLOW_IN_MEMORY_REVOCATION=true \
yarn workspace issuer-service start
yarn workspace issuer-service test
```

The end-to-end tests spawn `anvil` and build contracts with `forge`, so
Foundry must be installed and on `PATH`. They perform challenge, issuance,
response parsing, Noir input construction, proof generation, proof
verification, on-chain revocation-root validation, revocation, and the
registration flow below.

## Configuration

| Variable                                   | Default              | Purpose                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                                     | `3000`               | HTTP port                                                                                                                                                                                                         |
| `CHALLENGES_PER_MINUTE`                    | `30`                 | Requests per 60s window `POST /v1/challenge` accepts before answering `429`                                                                                                                                       |
| `ISSUANCES_PER_MINUTE`                     | `30`                 | Requests per 60s window `POST /v1/credentials` accepts before answering `429`                                                                                                                                     |
| `VERIFICATION_RECORD_TTL_SECONDS`          | `86400`              | Seconds verification outcomes remain readable before automatic deletion                                                                                                                                           |
| `MEMBER_SERVER_TOKEN`                      | required             | Bearer token for member-side governance, credential, verification, registration and delivery routes                                                                                                               |
| `MIN_DEVICE_SECURITY_LEVEL`                | TRUSTED_ENVIRONMENT  | Lowest attested device key security level issuance accepts: `SOFTWARE`, `TRUSTED_ENVIRONMENT`, `STRONGBOX`. `SOFTWARE` skips attestation                                                                          |
| `DEVICE_ATTESTATION_STATUS_URL`            | Google's             | Key attestation revocation list, `https://android.googleapis.com/attestation/status` by default. Fetched at startup and refreshed after, unless `MIN_DEVICE_SECURITY_LEVEL` is `SOFTWARE`                         |
| `DEVICE_ATTESTATION_MAX_STALENESS_SECONDS` | `259200`             | How old the last fetched revocation list may get before issuance answers `503 DEVICE_ATTESTATION_UNAVAILABLE`; at least `1800`                                                                                    |
| `ISSUER_NETWORK_ID`                        | `0xaa…aa`            | Issuer registry identity. With the governance keys set it must equal the id of `GOVERNANCE_AUTH_PRIVATE_KEY`'s public key, `keccak256(X \|\| Y)`; the server refuses to start otherwise and names the expected id |
| `ISSUER_PRIVATE_KEY`                       | required             | Stable 32-byte EdDSA issuer seed; required to start                                                                                                                                                               |
| `REGISTRY_ADDRESS`                         | unset                | Network member registry                                                                                                                                                                                           |
| `RPC_URL`                                  | unset                | RPC endpoint, shared by the approval gate and the registration route                                                                                                                                              |
| `CORS_ALLOWED_ORIGINS`                     | empty                | Comma-separated exact browser origins allowed by CORS, without paths or trailing slashes                                                                                                                          |
| `IDENTITY_REGISTRY_ADDRESS`                | unset                | `IdentityRegistry` address for enrolment checks and `POST /v1/registrations`                                                                                                                                      |
| `CHAIN_ID`                                 | unset                | Chain `IDENTITY_REGISTRY_ADDRESS` is deployed on                                                                                                                                                                  |
| `ISSUANCE_PROGRAMME`                       | unset                | Server-owned programme placed in credentials; required with the issuance gate                                                                                                                                     |
| `ISSUANCE_COUNTRY`                         | unset                | Server-owned three-letter country code placed in credentials; required with the issuance gate                                                                                                                     |
| `MEMBER_IDENTITY_SECRET`                   | unset                | 32-byte seed for this server's admitted Semaphore identity, shared by registration, revocation and the sponsored group                                                                                            |
| `SUBMITTER_PRIVATE_KEY`                    | unset                | 32-byte secp256k1 key that pays `registerIdentity` gas; attributes every enrolled user to its address, so needs `ALLOW_DIRECT_REGISTRATION=true`                                                                  |
| `ALLOW_DIRECT_REGISTRATION`                | `false`              | Opts into `SUBMITTER_PRIVATE_KEY`, instead of refusing to start                                                                                                                                                   |
| `ENTRY_POINT_ADDRESS`                      | unset                | ERC-4337 EntryPoint that relays registrations, deliveries and revocations                                                                                                                                         |
| `PAYMASTER_ADDRESS`                        | unset                | `SemaphorePaymaster` that sponsors each relayed registration, delivery and revocation                                                                                                                             |
| `ACCOUNT_IMPLEMENTATION_ADDRESS`           | unset                | EIP-7702 account implementation each disposable sender delegates to                                                                                                                                               |
| `BUNDLER_URL`                              | unset                | Bundler JSON-RPC endpoint; never echoed in an error, since hosted URLs embed API keys                                                                                                                             |
| `REGISTRATIONS_PER_MINUTE`                 | `30`                 | Requests per 60s window `POST /v1/registrations` accepts before answering `429`                                                                                                                                   |
| `MEMBER_GROUP_FROM_BLOCK`                  | `0`                  | Block at which the approved-member Semaphore group was created; hosted RPCs cap `eth_getLogs` ranges                                                                                                              |
| `PAYMASTER_GROUP_FROM_BLOCK`               | `0`                  | Block at which the paymaster's own Semaphore group was created                                                                                                                                                    |
| `LOG_WINDOW_BLOCKS`                        | unset                | Largest block span of one `eth_getLogs` call; unset reads each range in one call. Set it for RPCs that cap the span                                                                                               |
| `LOG_CONFIRMATIONS`                        | unset                | Blocks the governance join-request scan stays behind the head, out of reorg reach; unset rescans in full per read; set it to at least the provider's node skew (2 on public Sepolia RPCs) to read incrementally   |
| `ANNOUNCER_ADDRESS`                        | unset                | `ERC5564Announcer` address for `POST /v1/deliveries`                                                                                                                                                              |
| `MEMBER_PRIVATE_KEY`                       | unset                | 32-byte secp256k1 key that pays gas for `announce` and `revoke`; attributes each to its address, so needs the flags below                                                                                         |
| `ALLOW_DIRECT_DELIVERY`                    | `false`              | Opts into `MEMBER_PRIVATE_KEY` for `announce`, instead of refusing to start                                                                                                                                       |
| `DELIVERIES_PER_MINUTE`                    | `30`                 | Requests per 60s window `POST /v1/deliveries` accepts before answering `429`                                                                                                                                      |
| `REVOCATION_ADDRESS`                       | unset                | Deployed `CredentialRevocationRegistry` address; the revocation service and registry id behind it are read off the contract                                                                                       |
| `REVOCATIONS_PER_MINUTE`                   | `30`                 | Requests per 60s window `POST /v1/credentials/:id/revoke` accepts before answering `429`                                                                                                                          |
| `ALLOW_DIRECT_REVOCATION`                  | `false`              | Opts into `MEMBER_PRIVATE_KEY` for `revoke`, instead of refusing to start                                                                                                                                         |
| `ALLOW_IN_MEMORY_REVOCATION`               | `false`              | Opts into the in-process revocation mirror for local testing; credential issuance still requires the configured registries                                                                                        |
| `APPROVED_ISSUER_PUBLIC_KEYS`              | unset                | Extra `[x, y]` decimal-string issuer keys served by `GET /v1/issuers`, beyond this server's own; ignored once `APPROVED_ISSUER_SET_ADDRESS` is set                                                                |
| `CREDENTIAL_CIRCUIT_PATH`                  | zk-artifacts         | Compiled credential circuit, resolved against the app directory if relative                                                                                                                                       |
| `VERIFY_MAX_SKEW_SECONDS`                  | `300`                | How far a presentation request's `currentTime` may drift from this server's clock at verify time                                                                                                                  |
| `VERIFIER_AUDIENCE`                        | `ISSUER_NETWORK_ID`  | This server's own identifier, issued as `audience` by `POST /v1/presentation-requests`                                                                                                                            |
| `PRESENTATION_REQUEST_TTL_SECONDS`         | `300`                | How long a `POST /v1/presentation-requests` result stays valid before `POST /v1/verify` rejects it as expired                                                                                                     |
| `GOVERNANCE_AUTH_PRIVATE_KEY`              | unset                | This member's hot key, whose public key `requestToJoin` announces: signs `requestToJoin`, `registerNetworkMemberIdentity`, and `publishIssuerKey`                                                                 |
| `GOVERNANCE_SIGNER_PRIVATE_KEY`            | unset                | This member's seat at the governance Safe, distinct from the auth key                                                                                                                                             |
| `GOVERNANCE_SEMAPHORE_COMMITMENT`          | unset                | This member's own Semaphore identity commitment, announced by `requestToJoin`                                                                                                                                     |
| `GOVERNANCE_META_STEALTH_ADDRESS`          | unset                | This member's own meta-stealth address (66 bytes), recorded by `POST /v1/membership/identity`                                                                                                                     |
| `NETWORK_MEMBER_REGISTRY_ADDRESS`          | unset                | `NetworkMemberRegistry` address                                                                                                                                                                                   |
| `NETWORK_MEMBER_GROUP_ADDRESS`             | unset                | `NetworkMemberGroup` address                                                                                                                                                                                      |
| `NETWORK_MEMBER_GOVERNANCE_ADDRESS`        | unset                | `NetworkMemberGovernance` orchestrator address, enabled as a Safe module                                                                                                                                          |
| `GOVERNANCE_SAFE_ADDRESS`                  | unset                | The governance Safe                                                                                                                                                                                               |
| `APPROVED_ISSUER_SET_ADDRESS`              | unset                | `ApprovedIssuerSet` address; once set, `GET /v1/issuers` and `POST /v1/verify` read it instead of the in-memory set                                                                                               |
| `GOVERNANCE_MULTI_SEND_ADDRESS`            | canonical deployment | `MultiSendCallOnly` override, for a chain with no canonical Safe deployment                                                                                                                                       |
| `GOVERNANCE_DEPLOY_BLOCK`                  | `0`                  | Block the governance contracts were deployed at, so `getLogs` never scans before it                                                                                                                               |
| `GOVERNANCE_METADATA_URI`                  | `""`                 | Where `POST /v1/membership/requests` points approvers to vet this member                                                                                                                                          |
| `GOVERNANCE_SAFE_VERSION`                  | SDK default          | Safe contract version, for a Safe older than the SDK's default                                                                                                                                                    |

Setting the old `OPERATOR_TOKEN` variable refuses to start, naming
`MEMBER_SERVER_TOKEN` in its place.

The executable refuses to start without `RPC_URL`, `REGISTRY_ADDRESS`,
`IDENTITY_REGISTRY_ADDRESS`, `CHAIN_ID`, `ISSUANCE_PROGRAMME`, and
`ISSUANCE_COUNTRY`. Before signing, it checks the issuer's live membership,
`POST /v1/credentials` confirms the subject is enrolled in that registry and
that the wallet-requested scope exactly matches the server-owned programme
policy. Tests that construct `buildServer` directly may inject their own
identity reader and issuance policy.

`IDENTITY_REGISTRY_ADDRESS`, `CHAIN_ID`, and `MEMBER_IDENTITY_SECRET` are
all-or-none, and require `RPC_URL`. Once set, registration needs exactly one
sender:

- `ENTRY_POINT_ADDRESS`, `PAYMASTER_ADDRESS`, `ACCOUNT_IMPLEMENTATION_ADDRESS`,
  and `BUNDLER_URL`, all-or-none and requiring `RPC_URL`, relay each write
  through a fresh EIP-7702 stealth sender under the paymaster, so, with the
  shared bundler and paymaster described below, the chain records no address of
  this member. `MEMBER_IDENTITY_SECRET` also seeds those senders. At startup the
  server checks that the EntryPoint and account implementation have code and
  that the bundler serves the EntryPoint and `CHAIN_ID`.
- `SUBMITTER_PRIVATE_KEY` writes from one funded address and refuses to start
  unless `ALLOW_DIRECT_REGISTRATION=true`, since that address attributes every
  user this member enrols to it.

Setting both senders refuses to start. So does `MEMBER_IDENTITY_SECRET` with no
sender, unless a complete revocation group sets it. Without a sender,
`POST /v1/registrations` answers `503`.

The sponsored group is shared by registration, delivery and revocation: each
write goes out from a fresh stealth sender under the paymaster. The bundle
transaction's `tx.from` is the bundler's account, so a bundler this member runs
alone re-attributes every write: share one across members or use a public one.
Likewise `PAYMASTER_ADDRESS` must be the network's shared paymaster: one a
member runs for itself links every relayed write to that member through the
`UserOperationEvent`. The relay uses fixed gas limits and reads the fee from
the node (`packages/network-member-client/src/sponsored-relay.ts`). When the
limits times the fee exceed the paymaster's `MAX_COST_PER_OP`, the bundler
rejects the operation and registration answers `503`. When the bundler
accepted it, each attempt waits about two minutes for a receipt: a delivery then answers
`502 ANNOUNCE_FAILED`, and a revocation answers `500` once its three attempts
are spent, about six minutes in all.

With the sponsored group set, `IDENTITY_REGISTRY_ADDRESS`, `CHAIN_ID` and
`MEMBER_IDENTITY_SECRET`, all of which sponsored delivery needs, also start
sponsored registration, paid from the same deposit.

`ANNOUNCER_ADDRESS`, `IDENTITY_REGISTRY_ADDRESS`, and `CHAIN_ID` are
all-or-none, and require `RPC_URL`. Delivery takes one sender: the sponsored
group above relays each `announce`, so the `Announcement`'s indexed `caller`
names no member; `MEMBER_PRIVATE_KEY` announces from one funded address, which
attributes every delivery to this member, and refuses to start unless
`ALLOW_DIRECT_DELIVERY=true`. Without a sender the server refuses to start;
without the core variables, `POST /v1/deliveries` answers `503`.
`IDENTITY_REGISTRY_ADDRESS`/`CHAIN_ID` are shared with the registration group
above, but the groups can be configured independently: delivery without
registration, or registration without delivery, each only need their own
remaining variables (under the sponsored group, delivery with the secret also
starts sponsored registration).

`REVOCATION_ADDRESS` and `MEMBER_IDENTITY_SECRET` are all-or-none, and require
`RPC_URL`. Revocation takes the same sender choice: the sponsored group, or
`MEMBER_PRIVATE_KEY` behind `ALLOW_DIRECT_REVOCATION=true`. Setting
`MEMBER_PRIVATE_KEY` together with the sponsored group refuses to start when
delivery or revocation is configured, and so does `MEMBER_PRIVATE_KEY` without
the flag of a group it would serve.

Without the revocation variables, the server refuses to start: an in-process
mirror loses every revocation on restart and never sees another member's.
`ALLOW_IN_MEMORY_REVOCATION=true` keeps the old in-process mirror
instead, with the same gaps: `POST /v1/credentials/:id/revoke` still works,
but nothing is written to a chain, and `GET /v1/revocations/snapshot` reports
a null `registryAddress`/`registryId`. When the revocation variables are set,
the server rebuilds its mirror at startup from
the registry's own physical leaf slots (not by replaying revocation events,
since `unrevoke`/`updateRevocationCommitment` can change or tombstone a slot
after it was written) and refuses to start if the result doesn't match the
chain's own root. This protects a restart against a registry that already
held revocations.

The whole network revokes into one tree, so another member's write leaves this
server's mirror stale. A `revoke` proves membership once, then makes up to
three attempts: recompute the low-leaf index from the mirror, submit, and on
failure re-sync the mirror from the chain's leaves and try again with the same
proof. The same proof is safe to resubmit because the predecessor index was
never bound into the proof's message, and because a reverted call takes
Semaphore's nullifier write with it. Only after all three attempts fail does
the route answer `500`. `isRevoked` and `isValidRoot` are unaffected either
way, since both read the chain directly rather than the mirror.
`GET /v1/credentials` is the one route that does read
the mirror: the dashboard polls it per org every two seconds, and a chain read
per credential would make one listing cost the whole issuance history. A
revocation another member wrote therefore shows in the listing only once this
server has re-synced, while `GET /v1/credentials/:id` and `POST /v1/verify` see
it immediately.

Sponsored writes relay through a disposable stealth sender under the paymaster,
so the chain says nothing about which org revoked. A direct write goes out over
a plain EOA, whose address on chain says which org revoked. The membership proof
is required either way: the registry has no address-authorised path, so
`MEMBER_IDENTITY_SECRET` must be the seed of an identity admitted to the
approved-member group the registry gates on.

After `yarn deployAndConfigureAll:sepolia` or `:mainnet`, the founding member's
secret is in the `network-member.env` that deploy wrote
([Network member secret](../../packages/contracts/docs/configuration/1-before-deploy.md#network-member-secret)).

Each sponsored registration, announce and revoke uses a fresh sender, so each pays the
paymaster's Semaphore proof verify (over 200k gas, spec 05) from the shared
deposit. Nothing amortizes it across calls.

`GOVERNANCE_AUTH_PRIVATE_KEY`, `GOVERNANCE_SIGNER_PRIVATE_KEY`,
`GOVERNANCE_SEMAPHORE_COMMITMENT`, `GOVERNANCE_META_STEALTH_ADDRESS`,
`NETWORK_MEMBER_REGISTRY_ADDRESS`,
`NETWORK_MEMBER_GROUP_ADDRESS`, `NETWORK_MEMBER_GOVERNANCE_ADDRESS`,
`GOVERNANCE_SAFE_ADDRESS`, `APPROVED_ISSUER_SET_ADDRESS`, and `CHAIN_ID` are
all-or-none, and require `RPC_URL`. Without them, the governance routes and
the status page below are not mounted at all; a request to any of their
paths gets Express's own `404`, not a `503`. `GOVERNANCE_MULTI_SEND_ADDRESS`,
`GOVERNANCE_DEPLOY_BLOCK`, `GOVERNANCE_METADATA_URI`, and
`GOVERNANCE_SAFE_VERSION` are independent of the group: each has its own
default and is read whenever the group is complete.

## Member-side routes

`MEMBER_SERVER_TOKEN` guards every route that acts as this organisation: the
six governance routes, `GET /v1/credentials`, `GET /v1/credentials/:id`,
`POST /v1/credentials/:id/revoke`, `POST /v1/registrations` and
`POST /v1/deliveries`. The optional legacy `/v1/admission/*` routes and
`GET /v1/verifications/:id` are also protected. An environment-started server
refuses to start without the token. Each wants `Authorization: Bearer $MEMBER_SERVER_TOKEN`
and answers
`401 { "error": "member server token required", "code": "UNAUTHORIZED" }`
without it. Registration, delivery and revocation are also rate limited
(`REGISTRATIONS_PER_MINUTE`, `DELIVERIES_PER_MINUTE`, `REVOCATIONS_PER_MINUTE`,
all `30` by default), so a leaked token or a runaway client answers
`429 { "error": "rate limit exceeded", "code": "RATE_LIMITED" }` with a
`Retry-After` header instead of spending gas without bound.

Everything else stays open. `POST /v1/credentials` issues, and a wallet calls
it holding signatures over a short-lived challenge, which is that route's own
check; the same goes for `/v1/challenge`, `/v1/presentation-requests` and
`/v1/verify`.
`GET /v1/issuers` and `GET /v1/revocations/snapshot` are public reads.
`GET /`, `/v1/status` and `/v1/activity` are the demo's display surface, and a
presenter's screen does not hold this member's token: the page's HTML carries
none, and its buttons ask the presenter for one on the first click.

The token is required for every server started from the environment, so it
cannot come up with an open member-side API. `buildServer` still accepts none, which is
what the Node scenarios and the route tests mount in-process.

One limit worth stating rather than implying. Under `yarn stack`, `stack.json`
and the dashboard's open routes carry no token, each org's phone app pairs from
its own QR, and the dashboard's action proxy asks for a per-run key. But the
demo's operator still holds every org's token (in a `stack.secrets.json` outside
the repo), and the demo runs over plain HTTP, so a token crosses the network on
every call it makes. Run it on a network you trust. A real deployment issues one
token per operator and serves it over TLS.

## Endpoints

```text
GET  /health
POST /v1/challenge
POST /v1/credentials
GET  /v1/credentials
POST /v1/credentials/:id/revoke
GET  /v1/credentials/:id
POST /v1/registrations
POST /v1/deliveries
GET  /v1/issuers
GET  /v1/revocations/snapshot
POST /v1/presentation-requests
POST /v1/presentation-requests/:id/close
POST /v1/verify
GET  /v1/verifications/:id
GET  /v1/membership
POST /v1/membership/requests
GET  /v1/governance/requests
POST /v1/governance/admissions
POST /v1/membership/identity
POST /v1/membership/issuer-key
GET  /
GET  /v1/status
GET  /v1/activity
```

The demo stores nonces, issuance, delivery, and verification records in
memory. Challenges expire after five minutes, verification outcomes after 24
hours, and issuance records when their credential expires. Issuance records
retain only the device-key commitment; the raw device public key is discarded
after its possession proof is checked. Production deployments must provide
persistent stores that enforce the same deletion rules (including explicit
record deletion for erasure requests) and the live revocation registry.

`POST /v1/challenge` accepts `{ "subjectNetworkId": "0x…" }` and returns
`{ "challengeId": "…", "nonce": "…", "expiresAt": … }`. Challenge IDs are
opaque and request-scoped: asking again for the same subject does not replace
an earlier challenge. `POST /v1/credentials` must return `challengeId` with
the signed issuance fields. The service validates those signatures before it
atomically consumes the challenge; invalid proofs and missing, expired, or
replayed challenges all answer
`400 { "error": "issuance refused", "code": "ISSUANCE_REFUSED" }`.

`POST /v1/credentials` also takes `deviceAttestation`, the Android key attestation chain of
the device signing key (base64 DER, leaf first). Unless `MIN_DEVICE_SECURITY_LEVEL` is
`SOFTWARE`, the service verifies it after the signatures: the chain must reach one of Google's
pinned roots with no certificate on Google's revocation list, and the leaf must attest the
confirmation key as a hardware P-256 signing key, generated in the keystore, that needs the user
for every use, on a device with verified boot and a locked bootloader. The attested level must
meet the minimum. A failure answers `400 DEVICE_ATTESTATION_REJECTED`. When the revocation list
was never fetched or is older than `DEVICE_ATTESTATION_MAX_STALENESS_SECONDS`, it answers
`503 DEVICE_ATTESTATION_UNAVAILABLE`, so a deployment depends on reaching Google's list. Neither
consumes the challenge. At `SOFTWARE` nothing is fetched or checked. The chain is never stored
or logged.

The signed credential validity window is shared by every credential issued on
the same UTC day with the same configured duration: it starts at midnight and
ends at 23:59:59 on the final validity day. A duration shorter than one day
is rejected rather than silently extended. This avoids encoding the precise
issuance second in the private window that a verifier asks the wallet to prove.
Credentials issued by an older service retain their original second-level
windows; they must be reissued to receive the day-level privacy property.

The last nine routes above are mounted only when the governance variables
below are set; without them, the Node scenarios that build a server without
governance never see these paths, and get only Express's own `404`.

## Registration API

`POST /v1/registrations` submits a user's signed `RegistrationRequest`
(`@coordination-network/user-client`) to `IdentityRegistry`, as this server's
approved network member.

Request body:

| Field                | Type       | Width                     |
| -------------------- | ---------- | ------------------------- |
| `version`            | `"v1"`     | —                         |
| `networkId`          | hex string | 32 bytes (64 hex digits)  |
| `schemeId`           | `1`        | —                         |
| `metaStealthAddress` | hex string | 66 bytes (132 hex digits) |
| `chainId`            | number     | —                         |
| `verifyingContract`  | hex string | 20 bytes (40 hex digits)  |
| `signature`          | hex string | 65 bytes (130 hex digits) |

Responses:

| Status | Body                                                                                                                                 | Meaning                                                                                     |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `201`  | `{ "status": "submitted", "txHash": "0x…", "sponsorship"?: { … } }`                                                                  | Written; `txHash` is submitted, not confirmed                                               |
| `200`  | `{ "status": "alreadyRegistered", "metaStealthAddress": "0x…", "matchesRequest": true }`                                             | `networkId` already has an entry; `matchesRequest` compares it to the request's own address |
| `400`  | `{ "error": "malformed json" }`                                                                                                      | Body is not valid JSON                                                                      |
| `400`  | `{ "error": "malformed registration request" }`                                                                                      | Body failed schema validation                                                               |
| `400`  | `{ "error": "invalid registration request", "code": "INVALID_REGISTRATION_REQUEST" }`                                                | Signature or domain check failed                                                            |
| `401`  | `{ "error": "member server token required", "code": "UNAUTHORIZED" }`                                                                | Missing or wrong `Authorization: Bearer $MEMBER_SERVER_TOKEN`                               |
| `429`  | `{ "error": "rate limit exceeded", "code": "RATE_LIMITED" }`                                                                         | Over `REGISTRATIONS_PER_MINUTE` for this 60s window; carries `Retry-After`                  |
| `503`  | `{ "error": "registration not configured", "code": "NOT_CONFIGURED" }`                                                               | No registration sender or core variable above is set                                        |
| `503`  | `{ "error": "…", "code": "GROUP_MIRROR_UNAVAILABLE" \| "REGISTRY_UNAVAILABLE" \| "MEMBER_NOT_IN_GROUP" \| "REGISTRATION_REJECTED" }` | The registry or Semaphore group was unreachable, or rejected the write                      |

A sponsored write also puts a `sponsorship` object in the `201` body: the
disposable `sender`, `userOpHash`, `bundleTxHash`, `paymaster`, `actualGasCost`,
and the sender and paymaster-deposit balances before and after. Amounts are
decimal strings.

No `GET /v1/registrations/:networkId`: reads are public, and
`@coordination-network/user-client` already reads the chain directly.

This is a member-side route: since #255 the member app is the only submitter,
and it already holds the token, so the gate is enforcement of "only whoever
holds this member's token submits" rather than a new burden on a caller. It is
also rate limited (`REGISTRATIONS_PER_MINUTE`), mounted after the member
server token check, so a leaked token or a runaway client is bounded rather
than able to spend without limit: this member's `SUBMITTER_PRIVATE_KEY` gas, or,
on the sponsored path, the network's shared paymaster deposit that every
member's sponsored writes depend on.

## Delivery API

`POST /v1/deliveries` resolves a recipient's registered identity and announces
a fresh stealth address to it (`deliverToStealth`,
`@coordination-network/network-member-client`), as this server's approved
network member. With the sponsored group the announcement is sent through the
paymaster, so its `caller` is a one-time sender and the bundle transaction's
`tx.from` is the bundler's account.

Request body: `{ "networkId": "0x…" }`, the recipient's 32-byte network id.

Responses:

| Status | Body                                                                  | Meaning                                                             |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `201`  | `{ "status": "announced", "txHash": "0x…" }`                          | Announced; `txHash` is mined (sponsored) or only submitted (direct) |
| `401`  | `{ "error": "member server token required", "code": "UNAUTHORIZED" }` | No `Authorization: Bearer $MEMBER_SERVER_TOKEN`, or wrong one       |
| `403`  | `{ "error": "…", "code": "MEMBER_NOT_APPROVED" }`                     | This server's own network id is not approved                        |
| `422`  | `{ "error": "delivery refused", "code": "DELIVERY_REFUSED" }`         | No registered identity, or a malformed registered address           |
| `429`  | `{ "error": "rate limit exceeded", "code": "RATE_LIMITED" }`          | Over `DELIVERIES_PER_MINUTE`; carries `Retry-After`                 |
| `502`  | `{ "error": "announce failed", "code": "ANNOUNCE_FAILED" }`           | The announce transaction failed or reverted                         |
| `503`  | `{ "error": "deliveries not configured", "code": "NOT_CONFIGURED" }`  | The delivery core variables above are unset                         |

Like registration, this route is a member-side route, rate limited by
`DELIVERIES_PER_MINUTE`. Sponsored registrations, deliveries and revocations
spend the shared paymaster deposit, each behind its own limit
(`REGISTRATIONS_PER_MINUTE`, `DELIVERIES_PER_MINUTE`, `REVOCATIONS_PER_MINUTE`),
so a leaked token can spend it at up to the three limits combined. The response
carries no stealth address, since the recipient finds it by scanning, only the
`txHash`, mined when sponsored and only submitted when direct.

## Issuer set API

`GET /v1/issuers` returns the approved issuer set this member serves for
presentations: `{ "leaves": ["…", …], "root": "…", "blockNumber": "…", "approvedIssuerSet": "0x…" | null }`.
`leaves` and `root` are decimal strings. The user app rebuilds
`ApprovedIssuerSet.fromLeaves(leaves)` and checks it against the root it reads
from chain itself, not against this `root`; the web demo has no RPC client and
still compares against this one.

Without `APPROVED_ISSUER_SET_ADDRESS`, the set is in-memory: this server's own
credential signing key plus any keys from `APPROVED_ISSUER_PUBLIC_KEYS`,
`blockNumber` is `"0"`, and `approvedIssuerSet` is `null`. With it, every
field is read from the deployed `ApprovedIssuerSet` at one pinned block, and
`approvedIssuerSet` is that address. `POST /v1/verify` checks a presentation's
`approvedIssuerRoot` against the same backing, either way. Never `503`s.

## Revocation authorization

The network shares one registry. Any approved network member can update it with an anonymous Semaphore membership proof, including revoking another issuer's commitment. Phase 1 trusts members to use this authority correctly.

Admission adds the member to the Semaphore group. Before issuing credentials, it must also publish its signing key with `POST /v1/membership/issuer-key`; admission does not publish the key automatically.

## Revocation snapshot API

`GET /v1/revocations/snapshot` returns this member's revocation mirror:
`{ "registryAddress": "0x…" | null, "registryId": "…" | null, "root": "…", "snapshot": "…" }`.
`snapshot` is `RevocationRegistry.export()`; a holder rebuilds the tree from it
with `RevocationRegistry.import`. `registryAddress`/`registryId` name the
revocation service holding the tree and this network's registry on it, for a
client that would rather read the tree directly than import the snapshot; both
are `null` until the revocation variables above are set, but the route still
serves the in-process mirror either way. Never `503`s.

## Verification API

Verification is two steps, so every public input a presentation proves
against — challenge, audience, programme, and country — is one this server
chose, not one the submitter supplied. A proof that only showed internal
consistency between its own inputs and a self-declared `expected` block would
verify anywhere a relying party accepted that block; binding the inputs to a
request this server issued and marks used is what keeps a captured
presentation from verifying anywhere else.

`POST /v1/presentation-requests` issues one of those requests. Request body:
`{ "programme": "…", "country": "…" }` (country is 3 uppercase letters).
Response: `201 { "requestId": "urn:uuid:…", "challenge": "0x…" (31 bytes), "audience": "…", "currentTime": …, "programme": "…", "country": "…", "expiresAt": … }`.
`audience` is this server's own `VERIFIER_AUDIENCE`; `currentTime` is this
server's clock at request time. A member app forwards these fields to the
user app over the deep link along with `requestId`; the user app proves
against them and posts the result to `responseUrl`.

`POST /v1/presentation-requests/:id/close` takes
`{ "code": "CREDENTIAL_REVOKED" | "NO_CREDENTIAL" }` and answers
`200 { "verificationId": "urn:uuid:…" }`, or `404` for an unknown request. A
wallet that finds nothing worth presenting never posts a proof, so this is how
the member app reports why, rather than leaving the request to time out. It
consumes the request and stores the same shape of failed record `POST /v1/verify`
would, so one reader serves both.

`POST /v1/verify` takes `{ "requestId": "urn:uuid:…", "proof": "0x…", "publicInputs": […] }`
and verifies the proof (`verifyZkPresentationProof`,
`@coordination-network/credential`) against the stored request's own
challenge/audience/currentTime/programme/country, this server's approved
issuer set, and the network's revocation root.

A wallet proves issuer membership against the whole approved-issuer set, so the
`approvedIssuerRoot` a proof carries is that set's root and names no member.
This server requires it to be a root the set currently accepts, then checks the
proof's revocation root against the network's one registry. One tree is what
keeps the issuer hidden: with a registry per issuer, picking which one to ask
about a root would name the issuer the proof just hid.

Response: `200 { "verificationId": "urn:uuid:…", "ok": true }`, or
`200 { "verificationId"?: "urn:uuid:…", "ok": false, "code": "UNKNOWN_REQUEST" | "EXPIRED_REQUEST" | "CONSUMED_REQUEST" | "PUBLIC_INPUT_MISMATCH" | "PROOF_INVALID" | "ISSUER_ROOT_MISMATCH" | "REVOCATION_ROOT_INVALID" | "STALE_CURRENT_TIME" }`.

| Code                      | Meaning                                                                                                                                                                                                                                                                       |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNKNOWN_REQUEST`         | `requestId` was never issued (no `verificationId`: there is nothing to look back up)                                                                                                                                                                                          |
| `ISSUER_ROOT_MISMATCH`    | The proof's `approvedIssuerRoot` is not one the approved-issuer set currently accepts                                                                                                                                                                                         |
| `REVOCATION_ROOT_INVALID` | The proof's revocation root is not one the network's revocation registry currently accepts                                                                                                                                                                                    |
| `EXPIRED_REQUEST`         | The request is older than `PRESENTATION_REQUEST_TTL_SECONDS`                                                                                                                                                                                                                  |
| `CONSUMED_REQUEST`        | The request already reached a terminal outcome once, success or any failure past this point; a proof against it does not verify a second time                                                                                                                                 |
| `STALE_CURRENT_TIME`      | The request's `currentTime` was more than `VERIFY_MAX_SKEW_SECONDS` away from this server's clock at verify time — checked before the proof itself, since a proof verifies as long as `currentTime` matches its own baked-in public input, whether or not that time is recent |

A request is marked consumed on every terminal outcome, success included, so
a second attempt against the same `requestId` always answers
`CONSUMED_REQUEST`.

The verification result — never the proof itself — is stored and readable
back at `GET /v1/verifications/:id`
(`{ "verificationId", "ok", "code"?, "requestId", "audience", "currentTime", "challenge", "programme", "country", "verifiedAt" }`),
which 404s for an unknown id. `UNKNOWN_REQUEST` is not stored: there is no
request to attribute a record to.

`GET /v1/verifications/:id` requires `Authorization: Bearer $MEMBER_SERVER_TOKEN`.
The presentation-request and proof-submission routes remain open and are not
rate limited; a production deployment should add appropriate abuse controls.

## Governance API

Mounted only when the governance variables above are set. These routes are
what a member server runs itself as a candidate joining the network, an
approver admitting the next one, and an approved member publishing its own
records — the sequence `packages/contracts/docs/configuration/network-member-onboarding.md` in
`packages/contracts` describes.

`GET /v1/membership` reports this server's own standing:
`{ "networkId": "0x…", "authAddress": "0x…", "governanceSigner": "0x…", "metaStealthAddress": "0x…", "status": "approved" | "requested" | "none", "safe": { "address": "0x…", "threshold": …, "owners": ["0x…", …] }, "identityRegistered": …, "issuerKeyPublished": … }`.

`POST /v1/membership/requests` announces this server's own join request
(`requestToJoin`, passing the public key of `GOVERNANCE_AUTH_PRIVATE_KEY`), self-paid from that key.
Response: `201 { "txHash": "0x…" }`, or
`409 { "error": "already approved", "code": "AlreadyApproved" }` when this
member is already admitted.

`GET /v1/governance/requests` lists every `NetworkMemberJoinRequested` log
across the network whose member is not already approved:
`{ "requests": [{ "memberNetworkId": "0x…", "semaphoreCommitment": "…", "governanceSigner": "0x…", "metadataURI": "…" }, …] }`.

`POST /v1/governance/admissions` casts this org's approval of a candidate, and
executes the admission once enough orgs have cast theirs. **This is the most
consequential call this server makes**: the admission writes the candidate's
record into `NetworkMemberRegistry`, its leaf into the approved-member
Semaphore group, and its governance signer into the Safe's own owner set, all
three or none. Request body: `{ "networkId": "0x…" }`, the candidate being
admitted.

The call builds the Safe transaction from the candidate's own join-request log
and the Safe's live nonce and owner count, so every org reaches the same
`safeTxHash` and their approvals accumulate against one transaction. It records
this org's `approveHash` unless that approval already stands, then reads back
which owners have approved that exact hash. Below the Safe's threshold it
reports what is still missing and writes nothing else; at the threshold it
executes, passing every on-chain approval. So a network of two admitted orgs
takes two calls, one per org, and the second one is the admission.

| Status | Body                                                                                                                                                 | Meaning                                                                                                         |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `200`  | `{ "status": "admitted", "safeTxHash": "0x…", "approveTxHash": "0x…" \| null, "execTxHash": "0x…", "approvals": …, "threshold": …, "message": "…" }` | Admitted; `approveHash` lands as its own event first, so a dashboard can show it                                |
| `200`  | `{ "status": "awaitingApprovals", "safeTxHash": "0x…", "approveTxHash": "0x…" \| null, "approvals": …, "threshold": …, "message": "…" }`             | This org has approved; the admission waits for the rest. `approveTxHash` is `null` when it had already approved |
| `400`  | `{ "error": "…" }`                                                                                                                                   | Body failed schema validation                                                                                   |
| `404`  | `{ "error": "no pending request" }`                                                                                                                  | The candidate never called `requestToJoin`                                                                      |
| `409`  | `{ "error": "already approved" }`                                                                                                                    | The candidate is already a member                                                                               |

`POST /v1/membership/identity` records this server's own meta-stealth address
(`GOVERNANCE_META_STEALTH_ADDRESS`) in the member registry via
`registerNetworkMemberIdentity`, self-paid from the auth key. It takes no body:
the address is the server's, never the caller's. Response: `201 { "txHash": "0x…" }`,
or `409 { "error": "not approved yet", "code": "NotApproved" }` before admission.

`POST /v1/membership/issuer-key` publishes this server's own credential
signing key into `ApprovedIssuerSet` (`publishIssuerKey`), self-paid from the
auth key. No request body: the key is this server's own, never taken from the
caller. Response: `201 { "txHash": "0x…", "leaf": "…", "root": "…" }`, or
`409 { "error": "issuer key already published", "code": "IssuerKeyAlreadyPublished" }`
on a repeat. Any other revert, and any network failure, is a `500`.

All six are member-side routes: each wants
`Authorization: Bearer $MEMBER_SERVER_TOKEN`, admission included, not only the
ones that spend gas. None is rate limited. The
status page's own Membership panel below is a second caller of these same six
routes, not a separate surface, and its buttons send the token for that
reason.

## Status page

Also mounted only when the governance variables are set, since the page's
membership panel reads the same ports as `GET /v1/membership`.

`GET /` renders a framework-free HTML status page across three tabs:
**Actions** (the Membership panel, for running this server's own governance
actions), **Activity** (recent activity, with registrations folded under it)
and **Details** (identity and membership, issuer key and set, and a links
panel when `dashboardUrl`/`peers` are configured — `buildServer` options,
not environment variables). The links panel names each other org by its own
display name, so a network of three lists both of them. Each tab explains
itself in one line the first time a browser opens it, with a **Got it**
button that remembers the dismissal; the open tab is in the URL's fragment.

A panel leads with the badge that answers it at a glance — admitted or not,
key published or not — and folds its raw values (network id, addresses, key
coordinates, the issuer root) behind a closed `<details>` underneath. The
Membership panel's own actions and the recent-activity feed stay open
instead, since those are what a presenter points at during a demo; both the
registrations and recent activity panels drop each entry's own `refs`, so
its message reads as a plain sentence. The page polls its own JSON every two
seconds and rewrites each panel in place, including the panels inside tabs
nobody is looking at; the CSS tokens are copied from
`apps/web-demo/public/styles.css` so this page and the stack dashboard share
one look. `buildServer`'s `accent` option (not an environment variable) sets
this org's own `--accent` token, so the page's band, title rule and active
tab read in its brand colour; `apps/integration-testbed/src/serve.ts` passes
each org's own `brand.accent`.

The Safe's threshold and owners sit behind their own closed `<details>`, and
the Actions tab's intro folds the note that each button sends the member server
token. Depending on this server's own standing, the panel shows:
a **Request to join** button when it has no request in; a waiting line once
it has requested and isn't approved yet; and, once approved, a **Register
identity** button until `identityRegistered`, a **Publish issuer key**
button until `issuerKeyPublished`, and a "Pending requests" list with an
**Admit** button per candidate. Every button calls the matching route from
the Governance API above through the browser's own `fetch`, disables every
button for as long as one call is in flight — surviving the panel's own
2s poll, so a slow request can't be fired twice — and writes the
response's hashes (or a 409/404's `error` text) to an outcome line before
polling again. An org with nothing left to do — approved, registered,
published, nobody waiting — shows no buttons. Each button sends the member
server token, asked for with a browser prompt on the first click and kept in
the tab's `sessionStorage` (per origin, so per org) until the tab closes; a
`401` makes the page forget it and ask again. Under `yarn stack` it is that
member's `memberServerToken` in the `stack.secrets.json` whose path the stack
prints at startup.

`GET /v1/status` returns the JSON the page renders:
`{ "networkId": "0x…", "displayName": "…", "authAddress": "0x…", "membership": { … same shape as GET /v1/membership, minus networkId/authAddress/governanceSigner … }, "pendingRequests": [{ "memberNetworkId": "0x…", "metadataURI": "…" }, …], "issuerKey": { "x": "…", "y": "…", "published": … }, "issuerSet": { "address": "0x…" | null, "root": "…", "size": … }, "counts": { "registrations": …, "credentials": …, "revocations": …, "verifications": … } }`.
`issuerSet.size` is the set's live key count (`getSize()`), not its physical
slot count. `counts` are tallied from the last 200 activity entries, so they
are a recent window, not a lifetime total; `registrations` counts successful
writes only. `pendingRequests` is `[]` unless `membership.status` is
`"approved"`: only an approved member can admit anyone, so a candidate never
pays for that read. The Membership panel's own poll renders straight from
this route's `membership`/`pendingRequests` fields, rather than fetching
`GET /v1/membership` and `GET /v1/governance/requests` a second time.

`GET /v1/activity` returns `{ "entries": [{ "at": …, "kind": "registration" | "credential" | "revocation" | "verification" | "governance", "message": "…", "refs"?: { … } }, …] }`,
newest first, capped at the same 200-entry ring. Only governance entries
carry `refs` (this member's own transaction hashes and the candidates it
admits, all public on chain). Registration, credential and verification
entries carry a message and nothing else: a verification id would hand out
the key to its own endpoint, and a sender or user operation hash resolves in
one chain lookup to the user it was relayed for. A credential id is no
longer withheld the same way: `GET /v1/credentials` lists every issued
credential's id, programme, country, validity window, and revoked status
(no subject), behind the same member server token as the governance routes,
so the dashboard can offer a Revoke button per row.
`GET /v1/credentials/:id` answers with those same fields for one id, and
`POST /v1/credentials/:id/revoke` with the id and its new status: an id is
public, so nothing reachable by one may name the holder or carry the
commitment the credential is revoked under.

`GET /v1/activity` itself is open, like `GET /v1/status` and the page they both
feed: a presenter's screen does not hold this member's token. A deployment
that does not want its feed read puts the same token in front of all three.

## Cross-device presentation status

`GET /v1/presentation-requests/:id` requires the member server token and returns `pending`,
`expired`, `cancelled`, or `completed` with the stored verification record. It sends `Cache-Control:
no-store`. The original submission owns the result; a replay cannot replace it. This lets a
verifier phone recover the result even when the wallet loses its response or has no local callback.

`POST /v1/presentation-requests/:id/cancel` also requires the member token. It returns 200 when an
unsubmitted request is cancelled, 409 if submission has already claimed it, and 404 for an unknown
request. Cancellation does not undo a proof already in progress. Completed request IDs remain recoverable for the verification-record TTL (24 hours by default),
even after the challenge expiry. Status is server-local: like the
existing in-memory presentation store, a restart loses outstanding requests. Integrators providing
a persistent `PresentationRequestStore` must implement atomic `consume`/`cancel` and first-result
`complete` updates. The wallet only holds the public QR and never receives the member token.
