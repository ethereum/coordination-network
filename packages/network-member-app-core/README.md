# `@coordination-network/network-member-app-core`

The flows a network member's own app runs - enrol, issue, deliver, verify, revoke, and reading its
own membership status - written once against injected ports, so `apps/network-member-app` (Expo)
supplies only its own transport and screens on top. A member app never touches user key material:
it asks the user's app for a signature, a credential or a proof over the three-operation deep-link
protocol in `@coordination-network/user-app-link`, and drives its own member server
(`apps/issuer-service`) over HTTP. This member's own admission by governance - requesting to join, admitting a candidate,
registering its member record, publishing its issuer key - now runs from that member server's own
status page, not from this app.

## Install

```bash
yarn add @coordination-network/network-member-app-core @coordination-network/user-app-link
```

## Quickstart

```ts
import { createLinkClient } from "@coordination-network/user-app-link"
import { createMemberFlows, createMemberServerClient } from "@coordination-network/network-member-app-core"
import { policy, hooks } from "./business"

const flows = createMemberFlows({
    config: {
        networkId: "0x...",
        displayName: "Member A",
        serverUrl: "https://issuer.example",
        registry: { chainId: 1, verifyingContract: "0x..." }
    },
    link: createLinkClient({ caller: { name: "Member A", scheme: "member-a" }, callback, openUrl, onUrl }),
    server: createMemberServerClient({ baseUrl: "https://issuer.example", fetch }),
    policy,
    hooks
})

const outcome = await flows.enrol()
if (outcome.status === "registered" || outcome.status === "alreadyRegistered") {
    // show the subject's networkId / stealth address, and `outcome.sponsorship` if the paymaster paid
} else if (outcome.status === "refused") {
    // outcome.reason, outcome.code - a policy decision, not a bug
} else {
    // outcome.status === "failed": outcome.stage says where, outcome.error is a plain { message, code? }
}
```

## The subject-facing flows

Each is a thin, ported sequence over `link` (the deep-link protocol) and `server` (the member's own
HTTP API). Every outcome is a discriminated union on `status` - a screen switches on it, it never
throws for anything a user or a policy can cause. A `failed` outcome always carries a `stage`
naming exactly where the flow stopped, so a screen can report it without string-matching an error
message.

Each subject-facing flow asks the user app for exactly one of the protocol's three operations, so
the person approves once per flow rather than once per hop.

- **`enrol()`** - `registration.sign` -> `policy.decideEnrolment` -> `server.submitRegistration`,
  which sends the member server token too. The subject comes off the signed request itself, so what a
  screen shows and what the server records can never drift apart. The server's `alreadyRegistered`
  response is a first-class `EnrolOutcome`, not an error: it's how a second member discovers the
  same person already enrolled through another one (the network's deduplication story), and
  `hooks.onEnrolled` fires for it exactly as it does for a fresh `registered`. A `registered`
  outcome carries `sponsorship?` when the network's paymaster sponsored the registration - the
  sender, its balance before and after, the user operation hash, the bundle transaction, the gas
  the paymaster paid, and the paymaster's own deposit before and after.
- **`issue({ subject })`** - `policy.decideIssuance` -> `credential.issue`. The user app takes the
  four URLs this flow hands it and drives the whole issuance against this member's server itself -
  challenge, binding, signing, checking the lists, storing - so this member never handles the
  holder's proof-of-possession material. `alreadyHeld` is the answer when the person already holds
  one of this member's credentials, which is the user app's to give: the policy runs before the
  question is asked, and decides from this member's own records. The issuer server's own refusal
  comes back as `refused`, carrying its `code` and message.
- **`deliver({ networkId })`** - `server.deliver`, announcing a delivery to the recipient's
  registered stealth address; sends the member server token, like `submitRegistration`,
  `revokeCredential` and `getMembership`. Kept for the Node integration testbed; no app in this
  repo runs it.
- **`verify({ programme, country })`** - `server.createPresentationRequest` ->
  `presentation.create` -> `server.getVerification`. The member app never sees the proof and never
  declares what it expects: the user app posts the proof straight to the server's `/v1/verify`,
  checked against the presentation request the server itself issued, and returns only the id it
  was recorded under. The verdict is read back from this member's own server, never relayed by the
  wallet. A wallet that refuses to present at all (`CREDENTIAL_REVOKED`, `NO_CREDENTIAL`) never
  posts a proof, so the flow closes the request with that code and returns it as `rejected`,
  leaving no request to sit out its TTL.
- **`revoke({ credentialId })`** - `server.revokeCredential`.

`challengeUrl`, `credentialsUrl`, `issuersUrl`, `revocationsUrl` and `responseUrl` are derived from
`config.serverUrl` inside `issue` and `verify` (`/v1/challenge`, `/v1/credentials`, `/v1/issuers`,
`/v1/revocations/snapshot`, `/v1/verify`), so no app hardcodes them.

## This member's own network membership

- **`membershipStatus()`** - `GET /v1/membership`: this member's own `status`
  (`"approved" | "requested" | "none"`), the governance Safe's `threshold` and `owners`, and whether
  this member has registered its member record and published its issuer key. No `link` call, since
  it's about the member itself rather than a connected person, and a single server round trip, so a
  `failed` outcome's `stage` just names the flow.

Each flow is also exported as a free function - `enrol(ctx)`, `issue(ctx, input)`,
`membershipStatus(ctx)`, and so on, from `src/flows/*` - so a test can call one directly instead of
going through `createMemberFlows`.

## Ports (`MemberContext`)

| Port     | From                                                   | Purpose                                                                                                               |
| -------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `config` | the app                                                | `networkId`, `displayName`, `serverUrl` (no trailing slash), and the `IdentityRegistry` this member registers against |
| `link`   | `@coordination-network/user-app-link`, verbatim        | talks to the user app over the deep-link protocol                                                                     |
| `server` | this package's `createMemberServerClient`, or your own | talks to `apps/issuer-service`                                                                                        |
| `policy` | the app's `src/business/`                              | approve/refuse enrolment and issuance                                                                                 |
| `hooks`  | the app's `src/business/`, optional                    | side effects after a flow succeeds, and a single place to observe every failure                                       |

### `createMemberServerClient`

The default `MemberServerClient` implementation, shared by every app so the URL building, response
parsing and error mapping live in one place instead of four.

```ts
import { createMemberServerClient } from "@coordination-network/network-member-app-core"

const server = createMemberServerClient({ baseUrl: "https://issuer.example", fetch })
```

`fetch` is a minimal structural `FetchLike` (`(url, init?) => Promise<{ ok, status, text() }>`), so
both Hermes/React Native's and the browser's global `fetch` satisfy it without a DOM lib. Every
response is parsed with zod rather than cast; a non-2xx status throws `MemberServerError`, carrying
the server's own `code` where it sent one (falling back to a client-assigned code otherwise) - the
one exception is a 200/201 on `submitRegistration`, since `alreadyRegistered` is a value, not a
throw, for the reason above.

## The business module - the swap surface

`policy`, `hooks` and `branding` are what makes one member's app different from another's; the
flows above never change. A member app's own `src/business/` implements this package's
`MemberPolicy` and (optionally) `MemberHooks`, and bundles them with its `MemberBranding` as a
`MemberBusiness`:

```ts
// apps/network-member-app/src/business/index.ts
import type { MemberBusiness } from "@coordination-network/network-member-app-core"

export const business: MemberBusiness = {
    policy: {
        decideEnrolment: (subject) => ({ approved: true, value: undefined }),
        decideIssuance: (subject) => ({ approved: true, value: { programme: "demo-programme", country: "ZZZ" } })
    },
    hooks: {
        onIssued: (outcome) => analytics.track("credential_issued", { credentialId: outcome.credentialId }),
        onError: (event) => logger.error(event)
    },
    branding: { displayName: "Member A", accent: "#176b4d" }
}
```

Swap this file (or the whole `src/business/` directory) and the rest of the app - screens, the
deep-link wiring, the server client - is unchanged. `decideEnrolment`/`decideIssuance` may be
synchronous or async; a thrown hook never fails the flow it's attached to (`onError` sees it
instead), and `onError` itself is never allowed to fail a flow either.

## License

MIT, see [`LICENSE`](./LICENSE).
