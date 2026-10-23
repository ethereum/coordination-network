# `@coordination-network/user-client`

Single-call onboarding and registration for the coordination network: derive a device's keys via `@coordination-network/identity`, encode the ERC-6538 meta-stealth address, and hand a signed registration request to the network member's server, which writes `networkId -> metaStealthAddress` on `IdentityRegistry`, deduped against an already-registered identity.

## Install

```bash
yarn add @coordination-network/user-client
```

## Quickstart

```typescript
import { onboard, register, InMemoryIdentityRegistry, InMemoryMemberServer } from "@coordination-network/user-client"

// Derive this device's keys, networkId, and meta-stealth address.
const { networkId, displayMetaStealthAddress } = onboard(deviceSecret)

console.log(networkId) // 0x-prefixed bytes32
console.log(displayMetaStealthAddress) // "st:eth:0x..."

// InMemoryIdentityRegistry and InMemoryMemberServer are test/demo fakes standing in for the
// registry's read model and the network member's server. A real deployment splits this across
// two processes: the holder's app signs the request and hands it to the network member's app,
// which submits it to its own member server, carrying that server's own token — see
// "Dependency-injection seams" below.
const registry = new InMemoryIdentityRegistry()
const memberServer = new InMemoryMemberServer(registry, { chainId: 1, verifyingContract: "0x..." })

const result = await register({
    deviceSecret,
    registry,
    submitter: memberServer,
    domain: { chainId: 1, verifyingContract: "0x..." }
})

if (result.status === "registered") {
    console.log(result.receipt.txHash)
} else {
    console.log("already registered as", result.metaStealthAddress)
}
```

## API reference

| Export                            | Kind     | Description                                                                                                                                                                                                                                | Throws                                                                                                                   |
| --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `onboard`                         | function | Derives keys from a device secret and returns `{ keys, networkId, metaStealthAddress, displayMetaStealthAddress }`.                                                                                                                        | `InvalidMetaStealthAddressError` if the derived spending/viewing public keys are malformed.                              |
| `register`                        | function | Full flow: `onboard`, check for an existing registration, and submit if none exists.                                                                                                                                                       | `SubmissionFailedError`, `RegistryReadFailedError`, or `UserClientError` (`INVALID_INPUT`) on a malformed reader answer. |
| `metaStealthAddressFromKeys`      | function | Encodes a `DerivedKeys` bundle's spending/viewing keys into the 66-byte ERC-6538 scheme-1 meta-stealth address. Delegates to `@coordination-network/identity`.                                                                             | `InvalidMetaStealthAddressError` on a malformed spending/viewing public key.                                             |
| `displayMetaStealthAddress`       | function | Re-exported from `@coordination-network/identity` as `metaStealthAddressUri`. Formats a meta-stealth address hex string with the `st:eth:` display prefix.                                                                                 | —                                                                                                                        |
| `identityRegistryDomainSeparator` | function | Computes the EIP-712 domain separator naming the `IdentityRegistry` deployment the consent is bound to.                                                                                                                                    | —                                                                                                                        |
| `registerIdentityStructHash`      | function | Computes the EIP-712 `RegisterIdentity` struct hash for a `networkId`/`metaStealthAddress` pair.                                                                                                                                           | —                                                                                                                        |
| `registerIdentityDigest`          | function | Computes the final EIP-712 digest (`keccak256(0x1901 \|\| domainSeparator \|\| structHash)`) signed and verified by the registration flow.                                                                                                 | —                                                                                                                        |
| `signRegisterIdentity`            | function | Signs a digest with the account private key, returning a 65-byte `r \|\| s \|\| v` hex signature.                                                                                                                                          | —                                                                                                                        |
| `buildRegistrationRequest`        | function | Builds a fully-signed `RegistrationRequest` from a `DerivedKeys` bundle and a `ChainDomain`.                                                                                                                                               | `InvalidMetaStealthAddressError` (via `metaStealthAddressFromKeys`).                                                     |
| `verifyRegistrationRequest`       | function | Whether a member server pinned to `expected` should accept the request: field widths, a well-formed meta-stealth address, the domain, and a signer matching the full `networkId`. Returns `boolean`, never throws.                         | —                                                                                                                        |
| `InMemoryIdentityRegistry`        | class    | In-memory `RegistryReader` fake for tests/local dev. `registerIdentity` is write-once.                                                                                                                                                     | `registerIdentity` throws `SubmissionFailedError` (`InvalidMetaStealthAddressLength` or `AlreadyRegistered`).            |
| `InMemoryMemberServer`            | class    | In-memory `RegistrationSubmitter` fake standing in for an approved network member's server.                                                                                                                                                | `submit` throws `SubmissionFailedError` on `InvalidRegistrationRequest` or `AlreadyRegistered`.                          |
| `createHttpRegistrationSubmitter` | function | Builds a `RegistrationSubmitter` that POSTs to a member server's `/v1/registrations` endpoint over `fetch`.                                                                                                                                | `HttpSubmissionError` for every non-submitted response and on a network failure.                                         |
| `HttpSubmissionError`             | class    | Extends `SubmissionFailedError`. Carries `status`, `reason` (`"alreadyRegistered" \| "rejected" \| "unavailable" \| "unauthorized" \| "network" \| "invalidResponse"`), and when sent, `serverCode`/`metaStealthAddress`/`matchesRequest`. | —                                                                                                                        |
| `UserClientError`                 | class    | Base error class for this package, discriminated by `code: UserClientErrorCode`.                                                                                                                                                           | —                                                                                                                        |
| `InvalidMetaStealthAddressError`  | class    | Re-exported from `@coordination-network/identity`. Extends its `KeygenError`, not `UserClientError`, and names the malformed key. Thrown when encoding a meta-stealth address.                                                             | —                                                                                                                        |
| `SubmissionFailedError`           | class    | Extends `UserClientError` (`code: "SUBMISSION_FAILED"`). Thrown when a `RegistrationSubmitter.submit` call fails, including on a lost duplicate-registration race (see below).                                                             | —                                                                                                                        |
| `RegistryReadFailedError`         | class    | Extends `UserClientError` (`code: "REGISTRY_READ_FAILED"`). Thrown when a `RegistryReader.getIdentity` call rejects.                                                                                                                       | —                                                                                                                        |

## Meta-stealth-address encoding

`metaStealthAddressFromKeys`, in `src/meta.ts`, adapts a `DerivedKeys` bundle onto `@coordination-network/identity`'s `encodeMetaStealthAddress`; `displayMetaStealthAddress` is that package's `metaStealthAddressUri` under its local name. The encoding itself — and the validation behind it — lives in that package. The frozen conformance vectors in `tests/vectors/registration-vectors.json` pinned the encoding across that swap: every vector value is unchanged, which is what proves the change was byte-for-byte (only the `scheme.algorithm` description has been reworded since):

```
yarn tsx packages/user-client/tests/generate-vectors.ts
git diff --exit-code packages/user-client/tests/vectors/registration-vectors.json
```

## Dependency-injection seams: `RegistryReader` / `RegistrationSubmitter`

`verifyRegistrationRequest` takes the domain you expect as its second argument. A request carries its own `chainId` and `verifyingContract`, and neither is covered by the signature, so verifying against the request's own domain would only prove it is self-consistent — a signature made for another chain or another registry would pass. Pass the domain your registry is deployed at.

**Implementing `RegistryReader` against a chain.** `IdentityRegistry` stores the mapping as `bytes`, so its generated getter answers an unregistered `networkId` with empty bytes. viem and ethers surface that as `"0x"`, and the port requires `null`. `register()` rejects anything that is neither `null` nor a 66-byte entry rather than reading it as an existing registration, but an adapter should map the empty answer to `null` itself.

`RegistryReader` (read an identity's current registration) and `RegistrationSubmitter` (submit a new one) are dependency-injection interfaces, not concrete transports. On chain, writes are gated on an approved network member's Semaphore proof (`IdentityRegistry.registerIdentity(networkId, metaStealthAddress, proof)`; the proof comes from `@coordination-network/network-member-proof`). The user's signature is consent the member server verifies off chain with `verifyRegistrationRequest` before it builds the proof and submits; the contract never reads it. No credential check sits on this path (#46). The gas-sponsorship model is settled ([`specs/05-stealth-addresses.md`](../../specs/05-stealth-addresses.md), "Gas sponsorship"): registration stays self-submitted and self-paid by the network-member server, and only post-registration transactions go through the shared amortised Semaphore paymaster. Any future transport — a relayer, a meta-transaction relay, a bundler — plugs in as a new `RegistrationSubmitter` implementation without changing this package's API. `InMemoryIdentityRegistry` and `InMemoryMemberServer` are in-memory fakes for tests and local development; `@coordination-network/network-member-client`'s `IdentityRegistryClient` satisfies `RegistryReader` (it maps the getter's empty bytes to `null`); `createHttpRegistrationSubmitter` (below) is the member-side HTTP `RegistrationSubmitter`, for a process the organisation runs that holds its `memberServerToken`; it posts to `apps/issuer-service`'s `POST /v1/registrations`, which verifies consent with `verifyRegistrationRequest` and submits it via `network-member-client`'s `submitRegistration`.

### HTTP submitter

A member-side process calls `submitter.submit(request)` with the `RegistrationRequest` the holder already built and signed with this package's own `buildRegistrationRequest`. `createHttpRegistrationSubmitter({ url, memberServerToken })` POSTs that request as JSON to `${url}/v1/registrations` and maps the member server's response onto this package's types:

```typescript
import { createHttpRegistrationSubmitter } from "@coordination-network/user-client"

const submitter = createHttpRegistrationSubmitter({
    url: "https://member.example",
    memberServerToken: process.env.MEMBER_SERVER_TOKEN
})
await submitter.submit(request)
```

`memberServerToken` is the Network Member Server's own bearer token (`apps/issuer-service`'s `MEMBER_SERVER_TOKEN`), sent as `Authorization: Bearer <memberServerToken>` when set; the registration route now requires it. That token belongs to a member-side process the organisation itself runs, not to a holder — never pass one from a holder's wallet or app bundle.

Don't pair the Quickstart's `register()` composition with a `createHttpRegistrationSubmitter` that holds `memberServerToken` anywhere but a trusted single process such as a local testbed; on a holder's device, give `register()` a `RegistrationSubmitter` that hands the signed request to the member's app instead.

A `201` resolves `submit()` with `{ txHash }`. A `200` (the member server's `alreadyRegistered` response) throws `HttpSubmissionError` (`reason: "alreadyRegistered"`) carrying the registry's current `metaStealthAddress` and `matchesRequest`; a member-side caller has no device secret to re-run `register()` with, so treat those fields as the answer — the identity is already registered, and `matchesRequest` says whether it's already this request's address. A caller that is itself running `register()` (a trusted single process) can instead just re-run it: its own `registry.getIdentity` read will now see the entry and return the `alreadyRegistered` result instead. `400` throws `reason: "rejected"`; `401` (a missing or wrong `memberServerToken`) throws `reason: "unauthorized"`; `429` and `503` both throw `reason: "unavailable"` carrying the server's own `serverCode` (`"RATE_LIMITED"` for a `429`); and a network failure throws `reason: "network"`. `HttpSubmissionError` never includes the request body or its signature.

## Security notes

- **`status: "registered"` means submitted, not confirmed.** `register()` returns as soon as the injected `RegistrationSubmitter` resolves. It does not wait for inclusion or check a receipt, and `receipt.txHash` is `null` for a submitter that queues rather than broadcasts. A transaction that is mined and reverts also resolves here.
- **An existing entry is reported, not verified, and can change.** Only `registerIdentity` refuses a duplicate; an approved network member can `updateIdentity` or `removeIdentity` any entry at any time. If `alreadyRegistered` comes back with `matchesDerived: false`, this device's keys do not derive the meta-stealth address its `networkId` currently resolves to, and that is recoverable only through a member calling `updateIdentity`. A `matchesDerived: true` result is not permanent either — re-read `getIdentity` and compare against `metaStealthAddressFromKeys` whenever the mapping is load-bearing.
- **Consent is checked by the member server, not the chain.** `IdentityRegistry` gates writes on a Semaphore proof, not on the user's signature. A member server that skips `verifyRegistrationRequest` can register any `metaStealthAddress` under any `networkId`, since its membership proof covers whatever pair it submits. Comparing `metaStealthAddress` with `derivedMetaStealthAddress` (the bullet above) is how a user detects that.
- **`memberServerToken` leaking is worse than one bad registration.** Anyone who extracts it can act as that member on every member-side route, not just registration.
- **Duplicate-registration races.** If two `register()` calls for the same `networkId` are in flight at once, both will see no existing registration and both will attempt `submit()`. The losing submission surfaces as a `SubmissionFailedError` (`AlreadyRegistered`, in `InMemoryMemberServer`'s case). The caller should simply retry `register()`: the retry's `registry.getIdentity` lookup will now find the winner's registration and return the `alreadyRegistered` result instead of erroring.
- **React Native / Hermes.** `@coordination-network/identity`'s barrel loads on Hermes without a global `Buffer` — `onboard` and `register` don't need one. An app that also depends on something else expecting Node's `Buffer` may still want to set a polyfill globally for that code, but this package's own path does not require it.

## Integration test

`tests/integration` spawns `anvil`, deploys `SemaphoreVerifier`, `Semaphore`, and `IdentityRegistry` from the forge artifacts, and runs `register()` against the real contract with `IdentityRegistryClient` as the reader. It needs `anvil` on `PATH` and `yarn build:contracts` beforehand, and runs as part of `yarn test`; without `anvil` it is skipped locally and fails in CI.

## License

MIT, see [`LICENSE`](./LICENSE).
