# `@coordination-network/user-app-link`

The deep-link protocol between a **user app** (the crypto core on a phone: keys, credentials, proving) and any number of **network member apps** (business logic, no keys) on the same device. A member app opens a URL in the user app; the user app shows the person what's being asked, performs the operation, and opens the member app's callback URL with the result. Pure TypeScript, no React Native or Node-only APIs, testable in plain Node.

## Install

```bash
yarn add @coordination-network/user-app-link
```

## Protocol v1

**Request.** `${userAppScheme}://v1/request?payload=<base64url(JSON)>`, where `userAppScheme` defaults to `USER_APP_SCHEME` (`"userapp"`). The JSON payload:

```
{ id: string, version: "v1", caller: { name: string, scheme: string }, callback: string, op, params }
```

`id` identifies the request (typically a uuid); `callback` is the URL the user app opens with the response; `op`/`params` are one of the operations below.

`callback` (and `scheme`, if a caller overrides the default) must not contain a query string or fragment: `encodeResponse` always appends its own `?payload=`, so an existing `?`/`#` would bury or hide that parameter and the response would never decode — the member app's `request()` call would hang until it times out rather than resolve or reject. `encodeRequest`/`decodeRequest` refuse such a `callback` with `INVALID_REQUEST`/`LinkDecodeError`.

**Response.** `${callback}?payload=<base64url(JSON)>`, where the JSON payload is:

```
{ id, version: "v1", ok: true, result } | { id, version: "v1", ok: false, code, message? }
```

`code` is one of `USER_DENIED`, `CONSENT_DENIED`, `UNSUPPORTED_OP`, `INVALID_REQUEST`, `NOT_ONBOARDED`, `NO_CREDENTIAL`, `CREDENTIAL_REVOKED`, `PROOF_FAILED`, `ISSUER_UNREACHABLE`, `VERIFIER_UNREACHABLE`, `ISSUER_NOT_APPROVED`, `CHAIN_UNREACHABLE`, `INTERNAL`.

`message` is one fixed sentence per code (`LINK_ERROR_MESSAGES`), so a response never carries detail about the holder. The one exception is `INVALID_REQUEST` for malformed params, which describes the caller's own request.

**Size.** `encodeRequest`/`encodeResponse` throw `LinkPayloadTooLargeError` if the built URL exceeds `MAX_URL_LENGTH` (2000 characters) — the point past which platform `Linking.openURL` calls and some OSes start truncating or refusing a URL. Every result below fits comfortably; the two payloads that wouldn't (a credential and a ZK proof) never travel over a link at all — the user app fetches and posts both itself.

All hex strings are `0x`-prefixed and lowercase.

### Operations

Three ops, one per flow, each behind exactly one consent.

| Op                    | Params                                                                                                                                                        | Result                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registration.sign`   | `{ chainId: number, verifyingContract: hex20 }`                                                                                                               | `{ request: { version: "v1", networkId: hex32, schemeId: 1, metaStealthAddress: hex66, chainId: number, verifyingContract: hex20, signature: hex65 }, securityLevel }` |
| `credential.issue`    | `{ issuerNetworkId: hex32, approvalScope: { programme, country }, challengeUrl, credentialsUrl, issuersUrl, revocationsUrl }`                                 | `{ status: "stored", credentialId } \| { status: "alreadyHeld", credentialId } \| { status: "refused", code, message }`                                                |
| `presentation.create` | `{ requestId: string, challenge: hex31, audience: string, currentTime: number, programme: string, country: string, issuersUrl: string, responseUrl: string }` | `{ verificationId: string }`                                                                                                                                           |

`securityLevel` is one of `STRONGBOX`, `TRUSTED_ENVIRONMENT`, `SOFTWARE`, `UNKNOWN`. `registration.sign`'s `request` is posted to the member server verbatim; the security level rides along because registration is the first thing every member app does and nothing else in the request says how the phone guards its keys.

`credential.issue` runs the whole issuance inside the user app after one approval: it checks what it already holds, gets a nonce from `challengeUrl`, builds the proof-of-possession material, posts it to `credentialsUrl`, checks the credential it gets back against `issuersUrl` and `revocationsUrl` (lists that must hash to the chain's current roots, else `ISSUER_UNREACHABLE`), checks that its issuer key is one the chain lists for `issuerNetworkId` (`ISSUER_NOT_APPROVED`, or `CHAIN_UNREACHABLE` when the chain cannot be read), and stores it. The revocation secret never leaves the user app. `refused` is the issuer server's own decision, in its own error vocabulary; a server that cannot be reached at all is an `ISSUER_UNREACHABLE` error, not a refusal.

`presentation.create` does not return a proof. `requestId` identifies a presentation request the member server already issued via `POST /v1/presentation-requests` (which returns `{ requestId, challenge, audience, currentTime, programme, country }`); the rest of the params are that same response, since the user app still needs them to build the proof inputs. The user app picks a matching credential, checks it against the chain's current roots (the verifier's served lists must hash to them, or the request fails with `VERIFIER_UNREACHABLE`), proves it, asks the person once more before sharing, and itself `POST`s `{ requestId, proof, publicInputs }` to `responseUrl` (the member server's `/v1/verify`). The result is only the `verificationId`: the member app reads the outcome from its own server at `GET /v1/verifications/:id` rather than trusting a relayed answer. A proof is large — far past `MAX_URL_LENGTH` — so it never travels as a query parameter.

## Using `createLinkClient` (member app side)

```typescript
import * as Linking from "expo-linking"
import { createLinkClient } from "@coordination-network/user-app-link"

const client = createLinkClient({
    caller: { name: "Member App", scheme: "memberapp" },
    callback: Linking.createURL("v1/response"),
    openUrl: (url) => Linking.openURL(url),
    onUrl: (listener) => {
        const subscription = Linking.addEventListener("url", ({ url }) => listener(url))
        return () => subscription.remove()
    }
})

const signed = await client.request("registration.sign", { chainId, verifyingContract })
console.log(signed.request.networkId)
```

`request` encodes the op, opens the request URL in the user app, and resolves with the typed result (or rejects with a `LinkError` carrying the response's `code`) once the matching callback URL arrives. One request may be in flight at a time per client; a second call while one is pending rejects immediately.

### Phase 1 mobile presentation transport (#112)

The holder's wallet and verifier's member app can run on **separate Android phones**. The verifier
shows a public challenge QR; the holder scans it, reviews the request and consents to proving. The
wallet posts the proof directly to the verifier server (HTTPS for hosted services). The verifier
polls its server with its own member token; no app callback needs to cross devices. Both phones
need connectivity, and the wallet also needs its configured chain RPC. This is an online reference
demo, not a claim of offline suitability for every field deployment. The same-phone deep-link
flow remains available. Both configurations must name a verifier URL reachable from each phone;
localhost URLs require USB reverse forwarding on each device.

1. In the member app, choose **Verify → Check another phone → Create challenge QR**. The server's
   `POST /v1/presentation-requests` supplies the single-use challenge, audience, scope, time and
   expiry. The screen renders `cn-present:v1:` with a compact encoding of these fields and one
   server base URL. It carries no token, credential, proof or callback. URLs are reconstructed
   from that base; encoded QR data is capped at 2,000 characters.
2. In the wallet, choose **Scan proof → Scan challenge QR**. Before network access or consent,
   the wallet checks the schema and time bounds and pins the audience and every endpoint to a
   member in its previously configured stack. Scanning a QR never adds a new trusted verifier.
   The person reviews the configured verifier and programme/country, then approves sharing.
3. The wallet reads the verifier's lists and checks them against roots from its own chain RPC,
   builds the proof, and posts `{ requestId, proof, publicInputs }` to `/v1/verify`. A proof
   discloses time, challenge, audience, programme hash, country code and registry roots. The raw
   credential, issuer identity and private keys are not sent. The wallet reports **submitted**,
   not **verified**: only the verifier server's result establishes acceptance.
4. The verifier uses authenticated `GET /v1/presentation-requests/:id` to obtain `pending`,
   `expired`, `cancelled`, or `completed` with its stored verification record. This is how a lost
   wallet HTTP response can be recovered without replaying the proof. Only the original attempt
   can set this result; replay failures cannot replace a successful verdict. Polling stops on a
   terminal result, connection error, cancellation or screen exit. **Retry status** queries the
   same request after a connection error. **New check** creates a fresh challenge.
5. **Cancel check** or leaving the verifier screen stops waiting and calls authenticated
   `POST /v1/presentation-requests/:id/cancel`. Cancellation can invalidate an unsubmitted
   request; once proof submission has claimed it, the server returns 409 and may still record
   its result. The UI does not claim that an in-flight proof was cancelled.

**Payload and limits.** The proof travels as hex in JSON, not in the QR. The real-proof HTTP E2E
run measured 14,656 proof bytes, 29,886 JSON bytes and seven public inputs, within the server's
100 KiB parser limit. Circuit/backend changes must repeat that measurement. The member UI tests
rasterize the actual native QR Views and decode them with an independent QR decoder, checking
that the challenge fits and contains no token. The same-phone link tests also check its separate
2,000-character limit.

**Offline behaviour.** There is no cached-root/offline acceptance. A list/verifier outage produces
`VERIFIER_UNREACHABLE`; an RPC outage produces `CHAIN_UNREACHABLE` and no proof is submitted.
A lost proof-POST response is not acceptance or rejection: the verifier checks its own request
status. A consented no-credential/revoked-credential refusal sends no proof and closes the request
with that refusal. Denied consent sends nothing; the verifier can cancel or let the request expire. By default requests expire after 300 seconds. After expiry or cancellation, start a new
check rather than replaying the old proof. Hosted endpoints must use HTTPS; configured LAN HTTP
is retained for the local demo, where QR contents and network traffic are not confidential.

**Two-phone acceptance for #67.** Configure both phones against the same current Sepolia stack.
Issue a credential to the holder, display a challenge on the verifier, scan and consent on the
holder, and confirm that only the verifier shows the matching server verdict. Repeat with denied
consent, a revoked credential, a stale/unknown-member QR, duplicate scan frames, cancellation,
verifier/RPC outage, and loss of the wallet response after server acceptance. Never project member
pairing tokens or record credentials/proofs. Automated UI and local HTTP/Anvil tests cover these
boundaries, but do not replace physical-camera, secure-hardware and live-Sepolia acceptance.

### Browser transport

Member apps choose a transport only when constructing the client; all three operations and the rest of
their code stay the same when moving between web and mobile:

```typescript
import { createLinkClient } from "@coordination-network/user-app-link"
import { createWebLinkTransport } from "@coordination-network/user-app-link/web"

const client = createLinkClient({
    caller: { name: "Example Member App", scheme: "https://member.example" },
    callback: "examplemember://v1/response",
    ...createWebLinkTransport({
        userAppUrl: "https://user.example/link",
        userAppOrigin: "https://user.example"
    })
})
```

The user web app handles the popup URL and responds to the exact member-app origin:

```typescript
import { respondToWebLinkRequest } from "@coordination-network/user-app-link/web"

await respondToWebLinkRequest({ handler, allowedMemberOrigins: ["https://member.example"] })
```

The transport copies the encoded request query into the user web app's URL. The popup authenticates
its opener with a `postMessage` handshake, checks that origin against `allowedMemberOrigins`, and
requires the request's `caller.scheme` to match it. The member app likewise validates both the user
app origin and popup window. The custom-scheme callback remains inside the protocol payload and is
never navigated to or fetched.

## Using `createRequestHandler` (user app side)

```typescript
import { createRequestHandler } from "@coordination-network/user-app-link"

const handler = createRequestHandler({
    handlers: {
        "registration.sign": async (params, { caller }) => signRegistration(params)
        // ...one entry per op this build supports
    },
    consent: async (request) => showConsentScreen(request)
})

// From the Linking listener that receives an incoming userapp://v1/request URL:
const responseUrl = await handler.handle(incomingUrl)
await Linking.openURL(responseUrl)
```

`handle` decodes the URL, validates `params` against the op's schema, asks `consent`, and dispatches to the matching entry in `handlers`. Every failure — an unsupported op, invalid params, denied consent, or a handler that throws — becomes an `ok: false` response with the right `code`, never a throw. The one exception is a URL that can't be decoded into a well-formed envelope at all (bad base64, bad JSON, missing `id`/`callback`/wrong `version`): `handle` throws `LinkDecodeError` for that, since without a usable `id`/`callback` there is nowhere to send a response.

## Security notes

- **Responses stay on-device.** `callback` must be a custom app scheme; `encodeRequest`/`decodeRequest` refuse `http`, `https`, `intent`, `file`, `content`, `javascript`, and `data` (case-insensitive) with `INVALID_REQUEST`/`LinkDecodeError` before any response is ever built, so a member app can't point a response at a URL that leaves the device or, on Android, hands off to an arbitrary component instead of opening another app.
- **Neither side is authenticated.** This protocol doesn't verify which app sent a request or which app is answering it: a custom URL scheme isn't exclusive to one app, so another app claiming the same scheme could intercept a request or send back a forged response. Both apps should register the OS's verified-link mechanism for their scheme (Android App Links, iOS Universal Links) so only the genuine app can claim it, and the user app should show the resolved `callback` on its consent screen so a mismatch is visible before anything is approved. A signed response envelope, authenticating the response itself, is a planned follow-up.

## What this protocol deliberately does not do

- **No consent semantics.** `consent` is a plain predicate; what it shows, how it decides, and any policy around it (rate limits, remembered approvals, revocation) live in the user app, not this package.
- **No proofs over links.** A ZK proof is orders of magnitude larger than `MAX_URL_LENGTH`. `presentation.create` only ever carries the inputs to build one and the verifier's yes/no answer; the proof itself goes over an ordinary HTTPS `POST` from the user app to the member server.
- **No cross-device support.** Both apps are assumed to be installed on the same phone, communicating through the OS's own URL-scheme routing. There is no pairing, QR handoff, or relay for a user app and member app on different devices.
- **No responder authentication.** See "Security notes" above: this protocol alone doesn't prove `callback` belongs to the app the user thinks it does.

### Local demo relay

`createRelayWebLinkTransport` requires a private `token` for the running demo session. It sends it
in the Authorization header for requests, response polls and delivery acknowledgements. The relay
URL and the public stack descriptor must never carry that token. `browserSessionKey` reads an
operator pairing fragment or prompt, removes the fragment key and stores it only for that tab and
service. See the [relay setup](../../apps/integration-testbed/README.md#browser-link-relay-e1--l7).

## License

MIT, see [`LICENSE`](./LICENSE).
