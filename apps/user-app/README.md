# `user-app`

The User wallet: the person's crypto core. Holds the device key, the identity derived from it,
held credentials and revocation secrets, and no business logic. Serves the three
`@coordination-network/user-app-link` operations to any number of network member apps installed on
the same phone, each behind an explicit consent screen. All the crypto and storage logic lives in
`@coordination-network/user-app-core`; this app is the Expo shell around it, built on
`@coordination-network/app-ui`'s shared tokens and components — see those packages' READMEs for
what each operation does and why, and for the theme and component set.

## Running it

```sh
./scripts/sync-assets.sh
yarn android
```

**Expo Go cannot run this app.** It depends on `@coordination-network/expo-identity-keystore`
(a native module) and `@coordination-network/noir-prover-ffi` (the native proving bindings behind
`@coordination-network/noir-prover-native`) —
neither ships in Expo Go, so a dev build (`expo run:android` / `yarn android`) is required.

**Android only, for now.** The native keystore and prover modules have no iOS implementation yet.
It also needs a 64-bit Arm phone, or an arm64 emulator image, which only runs on Apple Silicon
hosts; x86_64 emulators aren't supported. 32-bit-only devices can't install it, since the native
prover ships for `arm64-v8a` only.

### On a phone over USB

Forward Metro's port, and the local stack's, back over the same cable, then install:

```sh
for p in 8081 8545 3001 3002 3003 4337 8080; do adb reverse tcp:$p tcp:$p; done
yarn android
npx expo start --localhost --port 8081
```

Both scripts pin `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1`, which is load-bearing rather than
tidiness. `expo run:android` starts a dev server of its own and launches the app against it, and
with nothing pinned Expo's `UrlCreator` falls back to `getIpAddress()` - so a freshly installed app
opened on `http://<laptop's LAN address>:8081`, which a phone reachable only over USB cannot route
to. It failed with `SocketTimeoutException`, and closing and reopening the app was what picked up
the localhost server started afterwards. Pinning the hostname makes both commands name the address
the reversed port already serves, so the first launch works. `run:android` takes no `--localhost`
flag of its own, which is why this is an environment variable.

Start the stack with `STACK_HOST=127.0.0.1` too, so the descriptor this app scans names localhost
rather than the laptop's LAN address. That forwarding is unused otherwise, since the app dials
whatever host the descriptor gave it. Testnet mode (`yarn stack:testnet`) keeps the same ports and
already defaults `STACK_HOST` to `127.0.0.1`.

Held credentials gained fields this round, so a phone carrying an older build's data should erase
it after installing — Settings → Erase everything — rather than mix old and new records.

Grant the camera permission "While using the app", not "Only this time" — Android kills a
backgrounded app's one-time grant, and a dev-client cold start through a deep link drops the
original request URL along with it. If that happens, open the app once from the launcher before
the next request.

Never tap a button on the dev launcher's error screen — a known crash in `expo-dev-launcher`
6.0.21. Relaunch from the launcher instead.

## What it does

A green band reading USER WALLET sits across the top of every screen, even while a consent
sheet covers it (the sheet caps itself with a compact copy of the same band) — a deep link can jump
here from either organisation app at any moment, and the person has to know which app they are
in.

Three deep-link operations, one per flow, each shown to the person as a consent sheet. The sheet
leads with a heading in the wallet's own words, which nothing in a request can change, then one
sentence naming the calling org and what approving does. Everything technical, the callback
included, waits behind a "Technical details" toggle:

- `registration.sign` — signs a stealth-address registration, and names this phone's security level
- `credential.issue` — runs the whole issuance: binds to this phone, asks the issuer to sign,
  checks the credential against that issuer's approved-issuer set and revocation snapshot, stores it
- `presentation.create` — asks what the proof would reveal, proves a ZK presentation, and posts it

Four tabs, switched with a plain tab bar (no router — the app is small enough that one isn't worth
the dependency). The first launch opens on Identity, since nothing else works before an identity
exists; every later launch opens on Credentials:

- **Credentials** — held credentials. Each card is the issuing org's: its name in the org's own ink
  and a stripe in its accent, both read from the loaded stack by the credential's issuer network id.
  Programme, country and the validity window are labelled rows, divided by hairlines, each with one
  sentence behind an info icon — a value like `ZZZ` says nothing on its own — and the ids fold away
  below them. An org the stack cannot name gets a shortened id in plain ink and no colour at all.
  The programme and issuer come from the issuer index the wallet wrote at issuance: the credential
  body itself carries only a one-way hash of the programme.

    The badge says whether the credential is still live, not just whether its dates are open. That
    takes an authority, and the network now has exactly one — the registry `stack.json` names — so
    the wallet reads it directly over the same RPC URL the Identity tab uses, which names no issuer.
    A revocation happens on the dashboard, so nothing tells the phone: the listing re-reads when the
    person returns to the app and on a pull. With no stack loaded there is nobody to ask, and the card
    says so rather than showing a green badge on the strength of its dates. A revoked card gives up
    the issuer's colour for the danger one and washes its surface, which is what reads from a
    distance; the badge alone did not.

- **Identity** — the identity above, each field with one sentence behind an info icon, plus an
  explicit "Create identity" action (nothing creates a device secret implicitly), and whether it's
  registered on chain — read from the Identity Registry directly, since this app has no server of
  its own to ask.
- **Config** — loads `stack.json` (the dashboard's output) by camera or paste, either its URL or
  the JSON itself. Identity's registration check needs the RPC URL and the Identity Registry
  address from it.
- **Settings** — erase everything, with one confirmation.

## Whose colour is whose

An org is drawn in its own colour only when the caller's declared name **and** its declared scheme
both match one member of the loaded stack (`src/members.ts`). Neither is verified by the OS, so
matching on the name alone would let any app calling itself Member A borrow Member A's blue. An
unmatched caller keeps the name it gave, in plain ink.

## Device key security level

Identity's security level (`STRONGBOX` / `TRUSTED_ENVIRONMENT` / `SOFTWARE` / `UNKNOWN`) is shown
verbatim from the identity the service reads.
Android below 12 (API 31) has no `PURPOSE_AGREE_KEY`, so the wallet does not start there: the boot
screen says "This wallet needs Android 12 or newer" rather than failing later.

Release builds refuse to create an identity below `TRUSTED_ENVIRONMENT`. Dev builds and Expo Go
allow `SOFTWARE`, so the in-memory fallback keeps working.

The signing key is generated with an Android key attestation challenge, and every issuance sends
its certificate chain. The issuer verifies the chain and refuses a level below its minimum. The
agreement key is not attested; the wallet's own `createIdentity` floor still covers it. Dev builds
on the software keystore send no chain, so they only work against issuers whose minimum is
`SOFTWARE`. The first start after the attestation update regenerates both keys once (their aliases
moved to `.v2`) and removes the credentials bound to the old ones, with the notice described below.

## Device key and user authentication

The phone holds two hardware keys, both non-exportable P-256 keys that need the user present
(fingerprint, face or screen-lock PIN):

- **Device signing key** — every signature needs a fresh authentication.
- **Device agreement key** — does the ECDH that roots the identity key. It has a 10 s window and is
  used once per app start, to unlock the identity seed.

Prompts per operation: listing credentials 0; issuing or presenting 1, plus 1 unlock on the first
key use after launch. `registration.sign` uses keys derived from the device secret, never a hardware key, and asks for nothing.

A screen lock is required; without one the wallet shows "Set a screen lock to use this wallet".
Removing or resetting the lock invalidates both keys, and the wallet replaces those two keys and
nothing else: deleting every key the app holds would also delete SecureStore's own key. Upgrading
from the one-key build, which had a single key, replaces them too. At every start, and right after a
replacement, the wallet removes the credentials bound to keys it no longer holds and says so. The
registration and the device secret are kept, so the person asks their organisation to re-issue the
credentials. After the lock is removed (Android 14 and newer delete the keys then), key uses fail
until the app restarts, and that next start replaces the keys and removes the credentials bound to
the old ones. A deep link that arrives during the brief key replacement gets no answer and has to
be retried.

iOS has no keystore module yet, so it runs on the in-memory software fallback.

## Secrets at rest

The device secret, each credential's revocation secret and a 32-byte store key
(`user-app.store-key`) live in SecureStore (`src/adapters/store.ts`). Credentials and the issuer
index live in AsyncStorage as AES-256-GCM envelopes (`enc1:` plus hex) under the store key, with
the AsyncStorage key name bound as associated data, so a record copied to another key won't open.
Records an older build wrote in plaintext are sealed on first read. A record that fails to open is left in place
and its read throws; Settings → Erase everything recovers. The scanned stack config bypasses the
store and stays in plain AsyncStorage. It holds only the descriptor's public fields: `stack.json`
carries no org's token, and the parse copies only the member fields this app reads. A config an
older build stored keeps the token its stack served until the next scan, and that token died with
the stack run that issued it.

On Android, SecureStore encrypts each value under an Android Keystore key. `app.json` sets
expo-secure-store's `configureAndroidBackup` explicitly, though it is also the default. Its rules
back up shared preferences only and leave SecureStore's file out, so neither the secrets nor
AsyncStorage's database reach a cloud backup or a device transfer.
`src/__tests__/app-config.test.ts` checks this on the resolved manifest.

The SecureStore items are deliberately not biometric-gated. SecureStore's `requireAuthentication`
prompts on every read and write, and enrolling a new fingerprint or face makes the item unreadable.
That would take the device secret with it, and with it the network ID and the stealth funds behind
it. The user-presence gate is the device signing key instead, which needs a fresh authentication for
every signature (see [Device key and user authentication](#device-key-and-user-authentication)).

Two parts of [spec 02's at-rest protection](../../specs/02-wallet.md#at-rest-protection) are not
met yet:

- **No StrongBox.** SecureStore can't request it, so the key is TEE-backed where the phone has one.
- **Key names stay readable.** AsyncStorage key names show credential ids and the issuer index's
  issuer, programme and country, and SecureStore item names are readable too. Only values are
  encrypted.

iOS has no build yet: there is no native keystore module, and SecureStore isn't given the
`WhenUnlockedThisDeviceOnly` keychain flag spec 02 asks for. The store key is a Keychain item like
the other two.

## One sheet per request

Approving doesn't close the consent sheet — its body is swapped in place, so the native modal is
never dismissed and re-presented mid-flow. The working body shows the op's label and the steps the
consent screen listed, driven by the `progress` port: issuance reports six steps and the sheet
groups them onto the three a person approved (`src/screens/steps.ts`), so the list never grows
after the fact. There is no clock — it measures the wait without shortening it — and no way to
dismiss the sheet early; it closes itself once the response has gone back to the caller.

A presentation gets a third body. Before anything is proved there is something concrete to ask
about, so the sheet lists what the verifier will learn and what it will not, and Share or Don't
share answers the `review` port. "Which org issued it" is on the will-not-learn list: a presentation
proves membership of the whole approved-issuer set, and the revocation root it carries belongs to
one network-wide registry, so neither the proof nor the verifier's check singles an issuer out.

The sheet also names which of the person's own credentials answered, which is for them and nobody
else. Two orgs running the same programme means either credential satisfies either verifier, and
`selection.ts` picks by expiry rather than by issuer — choosing by issuer is exactly what would give
the issuer away. Without that line, a revoked credential quietly replaced by a valid one from
another org looks like a wallet ignoring the revocation.

## Proving

Proving runs the native Noir/UltraHonk bindings synchronously on the JS thread — there is no way to
animate progress during it, only to show a "Proving…" state before the call and wait. It has not
yet been measured against real hardware; `src/adapters/prover.ts` is the same circuit `Wallet`
proves everywhere else, just proved natively instead of through `bb.js`/WASM (which Hermes lacks).
The native library loads on the first proof rather than at launch, so a load failure surfaces as
`PROOF_FAILED` to the requesting member app instead of stopping the app from starting.

**Nothing on this app's bundle uses `import()`.** Defer a module with a function-scoped `require`
instead. Expo's dev server bundles lazily, so a dynamic import becomes a separately fetched bundle
segment, and React Native reloads the whole app when such a segment registers while Metro's
websocket is down — `DevSettings.reload('Bundle Splitting – Metro disconnected')` in
`react-native/Libraries/Utilities/HMRClient.js`. That is what turned Approve on a presentation into
a dark window on a phone off Metro: the reload destroyed the JS instance holding the pending proof,
so the member app never got an answer. A `require` is an ordinary edge in Metro's graph, so the
module ships in the main bundle, and Metro still runs its body on the first require — deferral is
unaffected.

## Tests

```sh
yarn workspace user-app test --watchman=false
```

Native modules the covered code touches (`expo-secure-store`, `@react-native-async-storage/async-storage`,
`expo-linking`, `expo-asset`, `expo-camera`, `@coordination-network/noir-prover-ffi`) are mocked with
`jest.mock`; everything
else — the link round trip, the store adapter's backend routing, screen rendering, consent
approve/deny — runs against the real logic. Screen tests use
`@coordination-network/app-ui`'s test helpers, plus two of this app's own: `src/test-stack.ts`
(stack fixtures) and `src/test-text.ts` (`renderedText`, which reads a sentence naming an org
mid-line back whole, where `allText` would give `…with [object Object] to…`). Both live outside
`__tests__`, since jest treats every file under that directory as a suite of its own.
`src/adapters/device-key.ts` is tested against the in-memory `SoftwareKeystore` (provisioning
and migration, error wrapping); the prompts themselves are exercised on-device. `prover.ts`'s test
pins that it does not load `@coordination-network/noir-prover-ffi` at module scope and does load it on the first proof, so a
native load failure can't crash launch; the proving call itself is exercised on-device. Root Jest
does not see `apps/`, so there is
no repo-wide coverage threshold here; the tests are chosen to catch a real regression rather than
to hit a number.

## Presenting across two phones

The verifier opens **Verify → Check another phone → Create challenge QR** in the member app.
The holder opens **Scan proof → Scan challenge QR** in the wallet, scans, reviews and approves.
The wallet posts its proof directly to the verifier server; the member app polls its authenticated
request status and displays the verdict. Both phones need connectivity; the wallet also needs chain
RPC access. A submitted proof is not a confirmed success. On a polling connection error, use
**Retry status** for the same request; after expiry/cancellation use **New check**.

See the [transport decision and acceptance checklist](../../packages/user-app-link/README.md#phase-1-mobile-presentation-transport-112).
