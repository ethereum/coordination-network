# network-member-app

The Expo app a network member ships. It runs the org's own operations - register a wallet, issue a
credential, check that someone is eligible - and holds no user key material anywhere: it
asks the user's app for a signature, a credential or a proof over a deep-link protocol of three
operations (`registration.sign`, `credential.issue`, `presentation.create`), one consent each, and
drives its own member server over HTTP. Revoking a credential, and this org's own admission to the
network by governance, run from a browser instead: the network dashboard and the member server's
status page. Every flow comes from `@coordination-network/network-member-app-core`; this app is
screens, config and one small `src/business/` module wired to that package, on the shared
`@coordination-network/app-ui` design system.

The app installs as one of two orgs: **Member A**, blue, and **Member B**, yellow. The `AppBar` band
carries that name in that colour above every screen, so an audience watching a deep link jump between
this app and the green wallet always knows which one is on screen.

Everything else it draws comes from app-ui: every label/value block is a `FieldGroup`, ruled between
rows rather than spaced apart, and every verdict is an `Outcome` stamp. The app loads IBM Plex and
passes `fontsLoaded` to `ThemeProvider`; nothing waits on that, so a build where the faces never
arrive draws in the platform's own.

## Running two members side by side

The app installs twice on one device - one member, two instances - distinguished by
`EXPO_PUBLIC_MEMBER_ID` (`member-a` or `member-b`, matching the profiles in `eas.json` and the
scheme, Android package id, home-screen label and splash colour `app.config.ts` derives from it -
Member A in blue and Member B in yellow, the same names and colours `branding.ts` gives them on
screen):

```bash
yarn workspace network-member-app start:a
yarn workspace network-member-app start:b
```

Building a dev build for the second member needs `prebuild:b --clean` first. `expo run:android`
only prebuilds when `android/` is absent, so otherwise it reuses the first member's generated
package id and scheme and installs over that member instead of alongside it. Every script here
carries the member id itself, for the reason under "Running on a phone" below.

On first launch, each instance needs to be paired with a stack. Run `yarn stack` from
`apps/integration-testbed`; its terminal prints one pairing QR per org app. Scan this org's into
the app's Setup screen, or paste the link it encodes (`stack.secrets.json`, whose path the stack
prints, lists it too). The link is `<dashboard>/stack.json#org=<index>&token=<token>`: the app
fetches the open `stack.json`, which carries no token, and keeps the token from the fragment, which
never leaves the phone. `member-a` is org 0 and `member-b` org 1 - `src/config.ts` picks
positionally, since a stack's own member names don't know about this app's ids - and each refuses
the other's QR. The dashboard's own QR is the wallet's, and a pasted `stack.json` isn't accepted,
since neither carries this org's token. The demo stack stands up a third org as well, which has a
server and a status page but no phone app. The pairing is persisted, and "Change stack" on the
Settings tab re-opens Setup. An install paired before this scheme shows "set up for an older
stack" once, and asks to pair again.

## `src/business/` - the thing a member replaces

`policy.ts`, `hooks.ts`, `branding.ts` and `index.ts` are the only files specific to this org.
Everything else in the app - the screens, `src/link.ts`, `src/config.ts`, the flows themselves - is
shared plumbing every member's app uses identically.

- **`policy.ts`** decides `decideEnrolment`/`decideIssuance`. Both run before the user app is asked
  anything, so they see only the subject; the reference policy approves both. Whether that person
  already holds one of this org's credentials is the wallet's answer, arriving as the `alreadyHeld`
  outcome, so a real member decides here on eligibility it can check for itself.
- **`hooks.ts`** is the reference `MemberHooks`: it appends every flow outcome to an in-app activity
  log. A real member points these at its own logging or analytics instead.
- **`branding.ts`** is the display name and the four brand colours the screens read, derived from
  `memberId`: Member A is blue, Member B is yellow. They come from app-ui's `BRANDS` rather than from
  the stack, because Setup renders before any stack is loaded and the audience has to know whose app
  it is by then; `app.config.ts` mirrors both names and both accents for the launcher and the splash.

Replace this directory and the rest of the app is unchanged.

## What each screen calls

Four tabs: User, Verify, Activity, Settings. User is the landing tab.

- **User** - flows 2 and 4 for the connected person: `enrol()`, then `issue({ subject })`. It opens
  on an intro naming this org, "Register a wallet" and one button. `membershipStatus()` runs on
  mount, and an org that isn't admitted yet gets a "Not admitted yet" badge there - Register stays
  enabled regardless, and fails with the network's group error. After a registration the outcome
  reads "Registered" over "Gas paid by the Semaphore paymaster", with the gas figure, the sender,
  its balances, the user operation hash and the bundle transaction behind Technical details; then
  the Issue block is revealed, one button under the line saying the credential is reusable later to
  prove identity privately. A person the network already knows gets a neutral outcome instead -
  "Already registered", "Matches this device", "Not counted twice" - never the green check a fresh
  registration earns; a record held under another phone's stealth address reads "Different device"
  and blocks Issue, since this org cannot tell it apart from someone else's registration. Issue
  answers "Credential issued" with the programme and country, or "Already issued" when the wallet
  already holds one of this org's credentials.
- **Verify** - `verify({ programme, country, onStage })`: check that someone is eligible.
  It leads with what this org requires, and one Check button; the programme and country are
  editable behind Technical details. While it runs, "Asking the wallet" gives way to "Checking the
  proof" when the wallet answers and the server's record is being read - `onStage` reports that, so
  the second step waits on an event rather than a timer. The wallet posts its proof to this org's
  server and returns only the id it was recorded under; the screen renders what that server
  recorded, never what the wallet said about its own proof. The result is "Eligible" or "Not
  eligible" with one short line for the codes that have one ("Issuer not approved by this org",
  "Credential revoked", "No matching credential"); a link timeout reads as a prompt to reopen the
  wallet. The verification id, the code and the stage wait behind Technical details. Once a verdict
  is in, Check is replaced by a secondary "Check again": the verdict is this org's record of one
  presentation, and tapping Check would not re-read it but open a whole new request. A failure is
  the exception - nothing was recorded, so Check stays, since trying again is the recovery. The
  stage and the verdict are lifted into `App` like the User tab's, so a glance at another tab
  doesn't lose them.
- **Activity** - renders what `src/business/hooks.ts` recorded: plain sentences ("registered a new
  person", "issued a credential"), not a log of ids.
- **Settings** - this org's identity (name, role), with the network ID behind a Disclosure, and its
  membership, live from `membershipStatus()`, with the Safe rows behind another; a link to this
  org's own status page and to the network dashboard, each opened with `Linking.openURL`; and
  "Change stack", which re-opens Setup.
- **Setup** - pairs with a stack by camera or by pasting this org's pairing link. Shown only until
  the app is paired; not a tab.

Revoking is not here. The network dashboard lists every credential each org has issued with a
Revoke button on each, which is where an operator can see what they are revoking.

No screen ever asks the user app for a private key or performs a cryptographic operation - the
member server (`apps/issuer-service`) and the user app do that; this app only relays typed
outcomes.

## The governance walk

Admission by governance runs from `apps/issuer-service`'s status pages in a browser now, not from
this app. `yarn stack` starts a network that already exists: Member A and Member B admitted at
genesis on ports 3001 and 3002, and Member C a candidate on 3003 with a server and a status page but
no phone app. Two admitted orgs put the governance Safe at threshold 2, so admitting the third
takes both, from their status pages or from the dashboard's Network tab:

1. Member C's status page (port 3003): Request to join.
2. Member A's status page (port 3001): Admit. It records Member A's approval and says it is waiting
   for another org.
3. Member B's status page (port 3002): Admit. This one completes the quorum and executes.
4. Member C's status page: Register member record, then Publish issuer key.

An org's own status page asks for that org's `memberServerToken` (from the
`stack.secrets.json` whose path `yarn stack` prints) on the first click; the dashboard's Network
tab needs only the dashboard key, which its operator link carries.

An org's Register on the User tab is sponsored by the paymaster once that org is admitted; before
admission the same action fails with the network's group error.

## Running on a phone

Metro runs on the laptop; the phone reaches it over USB. Member A's Metro listens on 8082 and
Member B's on 8083, so both installs can talk to their own bundler at once. Forward both, plus every
port the stack listens on:

```bash
for p in 8082 8083 8545 3001 3002 3003 4337 8080; do adb reverse tcp:$p tcp:$p; done
```

Start the stack with `STACK_HOST=127.0.0.1` so the descriptor it hands the app names localhost
rather than the laptop's LAN address. Without that, the app dials the LAN address and this
forwarding goes unused, which shows up as a failed membership read against `http://<lan-ip>:3001`.
Testnet mode (`yarn stack:testnet`) keeps the same ports and already defaults `STACK_HOST` to `127.0.0.1`.

Then build and install the dev client, and start that member's own Metro:

```bash
yarn workspace network-member-app android:b
yarn workspace network-member-app start:b
```

**The member id and the port travel together, in one script each, on purpose.** Metro inlines
`EXPO_PUBLIC_MEMBER_ID` into the bundle, so whichever Metro serves a build decides which org that
build thinks it is - the two cannot be set independently without getting them wrong. Passing the id
by hand to a script that hardcoded a port did exactly that: `EXPO_PUBLIC_MEMBER_ID=member-b` with
`--port 8082` built Member B against Member A's bundler, and Member B would have come up as
Member A.

Both scripts also pin `REACT_NATIVE_PACKAGER_HOSTNAME=127.0.0.1`. `expo run:android` starts a dev
server of its own and launches the app against it, and with nothing pinned Expo's `UrlCreator`
falls back to `getIpAddress()` - so a freshly installed app opened on the laptop's LAN address,
which a phone on the cable cannot route to, and failed with `SocketTimeoutException` until it was
closed and reopened. `run:android` has no `--localhost` flag of its own, hence the variable.

Grant the camera permission "While using the app" - Setup's QR scanner needs it. If the dev
launcher's error screen ever appears, don't tap its buttons: a crash in expo-dev-launcher 6.0.21
takes the app down with them. Relaunch the app from the dev launcher's own list instead.

## Testing

```bash
yarn workspace network-member-app test
```

`expo-camera` is mocked in the tests that touch it (`tests/screens/Setup.test.tsx`); every other
flow-driven test builds a real `createMemberFlows` context over a fake `LinkClient` and a fake
`MemberServerClient`, so the screen, this app's `business/policy`, and the core package's flows are
all exercised together. Screen rendering is tested with `@coordination-network/app-ui`'s own testing
helpers (`allText`, `press`, `changeText`, `findPressables`); `jest.setup.js` calls Reanimated's
`setUpTests()`, without which an entering animation never resolves and every animated component
renders at opacity 0. A folded value's own test presses its Disclosure by `testID`
(`register-outcome-details`, `issue-outcome-details`, `verify-details`, `verify-settings`,
`settings-network-id`, `settings-membership-details`) and checks the value is absent before and
present after. Every string a test asserts is a string a screen shows.

## Presenting across two phones

The verifier opens **Verify → Check another phone → Create challenge QR** in the member app.
The holder opens **Scan proof → Scan challenge QR** in the wallet, scans, reviews and approves.
The wallet posts its proof directly to the verifier server; the member app polls its authenticated
request status and displays the verdict. Both phones need connectivity; the wallet also needs chain
RPC access. A submitted proof is not a confirmed success. On a polling connection error, use
**Retry status** for the same request; after expiry/cancellation use **New check**.

See the [transport decision and acceptance checklist](../../packages/user-app-link/README.md#ws1-mobile-presentation-transport-112).
