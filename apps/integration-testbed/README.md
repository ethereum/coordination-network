# Integration testbed

Real local E2E using Anvil, PostgreSQL, the issuer, indexer, credential circuit,
ERC-5564 stealth addresses and the Semaphore ERC-4337 paymaster.

Requirements: Docker, Foundry and Nargo.

## Multi-user simulation

```sh
yarn start
```

Registers Alice, Bob and Charlie. The Network Member gives Alice 100 tokens,
then separate sponsored operations transfer 40 to Bob and 25 to Charlie. Each transfer
and its announcement share one transaction; Bob and Charlie are not co-recipients
in a single transaction. Their common payer and nearby timing remain visible.

| User    | Final tokens | Stealth account | Credential |
| ------- | ------------ | --------------- | ---------- |
| Alice   | 35           | Recovered       | Revoked    |
| Bob     | 40           | Discovered      | —          |
| Charlie | 25           | Discovered      | —          |

## Minimal simulation

```sh
yarn start --minimal
```

Runs the same E2E with Alice and Bob only. Final balances are Alice 60 and Bob 40. Alice holds zero ETH in both modes; the paymaster sponsors the transfer.

Each run creates and removes its own Anvil process and PostgreSQL container.
This is a local simulation, not a public-testnet deployment.

## Web demo

Start the browser demo's local stack with:

```sh
STACK_MIN_DEVICE_SECURITY_LEVEL=SOFTWARE yarn demo
```

Then follow the [browser relay setup](#browser-link-relay-e1--l7) to start the relay, wallet and member pages.

## Dashboard

```sh
yarn serve
```

Starts the local stack and its dashboard, refreshed every 2s, across five tabs:

- **Flow**, the one a room watches. A live line names the newest thing any org has reported, then
  the five-flow story: onboard the user, verify and issue the credential, prove with the
  credential, revoke the credential, and a second founder signing up the same person. Each flow
  carries a live status and, where relevant, a per-org detail line. The stack's own recent
  activity follows.
- **Orgs**, one card per org left-bordered in its brand colour: whether its server answers,
  whether the network admitted it, its counts, what it has issued with a Revoke button per
  unrevoked row, and a link to its own status page.
- **Network**, the orgs admitted, the issuer keys published and the governance Safe, with a
  Request to join button for an org that has not asked and an Admit button per founder for one
  that has. The Safe's own rows fold.
- **Chain**, the chain, contracts, paymaster and bundler, each folded shut.
- **Connect**, the QR a phone scans, with the descriptor it carries folded underneath.

A tab explains itself the first time: one line with a **Got it** button, remembered per browser.
When a poll finds something new on a tab nobody is looking at — gas sponsored, an org asking to
join or admitted, a credential issued or revoked — a hint pops under that tab for six seconds.
The open tab is in the URL's fragment, so a link can point at one.

The dashboard never asks the browser to reach an org server directly. Member servers disable CORS
by default, so every governance and credential action posts through the dashboard's own
`/api/orgs/:index/{request-to-join,admit,register-identity,publish-issuer-key,revoke}` and
`GET /api/orgs/:index/credentials`, which relay to that org's own server and back. The proxy's
POST routes take `application/json` and answer `415` to anything else: the dashboard binds to
every interface, and a form POST from another origin needs no preflight, so a page a browser on
this LAN happens to visit must not be able to admit an org or revoke a credential.

Every `/api/orgs/*` route also wants `Authorization: Bearer <dashboard key>`, a key drawn fresh
each run, and answers `401` without it, before any other check. Open the operator link from
`stack.secrets.json` (`…/#key=…`) and the page keeps the key for that tab; without it, the first
click asks. A browser that merely reaches the port still sees the whole dashboard, including each
org's credential list on the Orgs tab, but can't act as any org.

### The address the apps are told to use

Every URL in `stack.json` carries one host, and the phone apps use it verbatim, so it decides
whether they reach this stack over Wi-Fi or over the USB cable. By default the stack picks the
laptop's own LAN address, which needs the phone on the same network. Set `STACK_HOST=127.0.0.1`
(an IP address, not `localhost`) and every URL becomes a localhost one, which reaches the laptop through `adb reverse` instead:

```sh
STACK_HOST=127.0.0.1 yarn serve
```

Prefer that whenever a phone is on the cable. Forwarding the ports without it does nothing, since
the apps never dial localhost in the first place.

### Pairing a member app

`stack.json` carries no member server token. The stack writes every org's token, the dashboard
key, and each org's pairing link to a `stack.secrets.json` in a fresh directory under the OS temp
dir, readable by you alone, and prints its path. It is never inside the repo, because both web
apps run Vite on every interface, and Vite serves any file in the workspace.

Each org that ships a phone app gets its own pairing QR in the terminal, encoding
`<dashboard>/stack.json#org=<index>&token=<token>`. Scan it from that org's app, or paste the
link from the secrets file. The token sits in the fragment, so the app's fetch of `stack.json`
sends nothing secret. The QR on the dashboard's Connect tab is the public one, which the wallet
scans. A pairing QR is that org's token: keep it off a projected screen.

Two limits remain. Every call is plain HTTP, and anvil listens on every interface with account
impersonation enabled, so anyone on the network can act on chain directly. Run the demo on a
network you trust.

### The three orgs

The stack stands up a network that already exists. Member A and Member B are founders, admitted at
genesis and serving on :3001 and :3002, so the five flows run between them from the first minute.
Member C is a candidate on :3003, with a server and a status page but no phone app: it is what the
admission story is about. Each org's `stack.json` entry carries a `brand` (its four colours) and,
for Member A and Member B, a `scheme` (the org app's own deep-link scheme).

Set `STACK_MEMBER_SEEDS` to three comma-separated 32-byte hex seeds to make the orgs' keys
reproducible, and `STACK_MEMBER_PORTS` to move the servers: one port per org, three total.

`STACK_MIN_DEVICE_SECURITY_LEVEL` (`SOFTWARE` by default, or `TRUSTED_ENVIRONMENT`, `STRONGBOX`) sets
the lowest attested device key level the three servers accept. Above `SOFTWARE` they verify the
phone's attestation chain, which needs outbound access to Google's revocation list; `--check` and
the Node scenarios hold software keys, so they only run at `SOFTWARE`.

### Admitting Member C

Two founders put the governance Safe at threshold 2, the majority its own rule
(`governanceThreshold`) gives two owners, so no single org can admit anyone. On the dashboard's
Network tab, Member C gets a **Request to join** button; both founders then see the request and each
gets an **Admit as Member A** / **Admit as Member B** button (the same buttons exist on each org's
own status page, since the underlying routes are unchanged; that page asks for the org's
`memberServerToken` from `stack.secrets.json` on the first click). Member A's click records its
approval and answers that it is waiting for another org; Member B's click completes the quorum and
executes, and Member C is in. The tab reads "2 of 3" until that second click and "3 of 3" after it.

```sh
yarn workspace integration-testbed serve --check
```

Runs the same stack unattended and asserts that whole story, plus the sponsored-registration
paths, against a real anvil and three servers.

## Testnet mode

```sh
yarn stack:genesis   # sets the network up once; rerun it to refill
yarn stack:testnet   # serve it
```

`TESTBED_MODE=testnet` runs the member servers, the bundler, the dashboard and `stack.json` against a
network that is already deployed, and deploys nothing. Deploy first with the runbook's
`deployAndConfigureAll` ([`packages/contracts/docs`](../../packages/contracts/docs/testing/e2e-runbook.md)):
it deploys the contracts, wires the governance module and the issuer set, funds the paymaster and admits a
founding member whose seat at the Safe is `OWNER`. That leaves a Safe owned by `OWNER` alone at threshold 1.
The deployer can never own the Safe. The network's own addresses come from
`packages/contracts/deployments/<chainId>.json`; the shared third-party ones are pinned in `src/config.ts`.
The phones keep the same ports. To record a full run on Sepolia, follow the
[Sepolia demo](../docs/docs/guides/sepolia-demo.mdx) page.

| Variable                          | Meaning                                                                                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TESTBED_MODE`                    | `testnet`. Set by the two scripts above.                                                                                                                                                       |
| `RPC_URL`                         | The chain's JSON-RPC endpoint. The member servers and the bundler use it directly.                                                                                                             |
| `OWNER_PRIVATE_KEY`               | The runbook's `OWNER`: the Safe's first owner, the paymaster's owner and group admin. Genesis and the paymaster mirror sign with it.                                                           |
| `STACK_MEMBER_SEEDS`              | Required and secret. Three distinct comma-separated 32-byte hex seeds for Member A, Member B and Member C. Never the founding member's secret.                                                 |
| `STACK_BUNDLER_PRIVATE_KEY`       | Required. A key used for the bundler's gas only. With or without `0x`.                                                                                                                         |
| `DEPLOYMENT_FILE`                 | A deployment file other than the one named for the chain id; a relative path is from the repository root. Needed until `deployments/11155111.json` is replaced by a deployment of this branch. |
| `STACK_HOST`                      | The one address every listener binds and `stack.json` advertises. An IPv4 address other than `0.0.0.0`. Defaults to `127.0.0.1`.                                                               |
| `STACK_PUBLIC_RPC_URL`            | Optional. What `stack.json` tells the phones to use, instead of this stack's own proxy. Refused if it repeats `RPC_URL`'s hostname, password, path or query.                                   |
| `STACK_LOG_WINDOW_BLOCKS`         | Optional. The widest `eth_getLogs` range the provider accepts. Defaults to 10000.                                                                                                              |
| `STACK_MIN_DEVICE_SECURITY_LEVEL` | Optional. As locally; `SOFTWARE` by default.                                                                                                                                                   |

`STACK_PORT` is the RPC proxy's port. `STACK_MEMBER_PORTS`, `STACK_BUNDLER_PORT` and
`STACK_DASHBOARD_PORT` mean what they do locally. A blank variable counts as unset. The org keys derive
from the member seeds, so a restart finds the same Safe owners and the same funded accounts.

**Who can reach it.** Every listener (the dashboard, the bundler, the member servers and the RPC proxy)
binds `STACK_HOST`, which defaults to loopback, so only a phone tethered over USB (`adb reverse`) reaches
the stack. The stack refuses a host that is not an IPv4 address at startup: the dashboard and the proxy
answer 421 to a request whose Host is a DNS name. The dashboard's buttons send permanent transactions as
each org behind the dashboard key. That key and every org's member server token travel over plain
HTTP, so setting `STACK_HOST` to a LAN address exposes them to everyone on that network. Do not do
that on shared Wi-Fi. The bundler also pays gas
only for user operations that name this deployment's paymaster.

**Provider.** It must serve `eth_getLogs` over `STACK_LOG_WINDOW_BLOCKS` blocks. Alchemy's free tier caps a
range at 10 blocks and is unsuitable. The member servers and the dashboard read governance events two
blocks after they land, so on Sepolia one shows up about half a minute later; `--check` waits for it.

### Preflight

Serving first reads the deployment and refuses to start unless it finds it ready. It prints one line per
problem, all at once, and sends nothing: the chain id, missing contract code, a registry that predates
the account-key contracts (point `DEPLOYMENT_FILE` at a deployment of this branch), the governance module
and issuer-set wiring, the paymaster's group admin, each founder's approval, group membership,
Safe seat, registered governance signer and own issuer key, the Safe threshold against the governance
rule, account and paymaster balances, and whether the provider accepts the log window. A candidate that
is already admitted is a warning, and so is a Safe grown past what the stack's seats can approve (it
still serves, and `--check-admission` refuses it) and a founder missing from the paymaster group (the
mirror adds it at start).

### Genesis

`yarn stack:genesis` does the on-chain setup the demo network needs, and only what is missing. It runs its
own preflight first, then tops up the three org accounts, the founders' governance signers and the
bundler from `OWNER`, adds to the paymaster's deposit when it is low (never its stake), admits Member A and
then Member B through the Safe, publishes each founder's own issuer key and mirrors the paymaster group.
Every transaction prints its hash before it waits, and a refusal comes before the first one. Genesis
sets the network up once and is rerun to refill drained accounts or the paymaster's deposit; a rerun only
sends what is missing. Do not run it while the stack serves: both sign as `OWNER`, and two senders on one
account collide on nonces.

`OWNER` needs about 0.50 ETH for genesis, on top of what `deployAndConfigureAll` spends: 0.05 ETH for
each of the five org accounts and governance signers, 0.2 ETH for the bundler and 0.05 ETH of gas margin,
plus up to 0.05 ETH if the paymaster's deposit is low. The preflight refuses with the exact figure when
`OWNER` holds less.

| Step                 | Safe before           | Signed by             | Safe after            |
| -------------------- | --------------------- | --------------------- | --------------------- |
| Admit Member A       | `OWNER`, threshold 1  | `OWNER`               | 2 owners, threshold 2 |
| Admit Member B       | 2 owners, threshold 2 | `OWNER` and Member A  | 3 owners, threshold 2 |
| The candidate, later | 3 owners, threshold 2 | Member A and Member B | 4 owners, threshold 3 |

`OWNER` keeps its seat, because it is the founding member's. Genesis holds `OWNER`, the founders'
governance keys and their auth keys, all from the environment and the seeds; with other seeds it stops
before it spends anything, because the keys it holds no longer reach the Safe's threshold. Keep
`STACK_MEMBER_SEEDS` and put the variables in an untracked file (`.stack.env` is ignored), not on the
command line, where shell history keeps them.

### Checking it

```sh
TESTBED_MODE=testnet yarn workspace integration-testbed serve --check
```

`--check` works in both modes. Against a deployed network it skips the admission story, because
admitting Member C changes the network for good. `--check-admission` (which implies `--check`)
plays it, only while Member C is not yet approved: it asks Member A and Member B to admit the candidate
through the dashboard, with the Safe at `OWNER`, Member A and Member B.

`--check-admission` resumes after a request with no or one approval: if Member C's request is
already on chain it skips the request and goes on with the founders' approvals. If both approvals landed
before the stop, finish the admission from the dashboard. It refuses, before it spends anything, when the
stack's own seats cannot reach the Safe's threshold, which the serve preflight only warns about.

Every testnet `--check`, with or without the flag, spends money and leaves marks on the chain: it
sponsors three registrations and a delivery (paymaster deposit and bundler gas) and revokes a credential
through a sponsored operation. There is no reset route: the member servers do not mount the admission
router, so the story runs once per deployment.

### The RPC proxy

`stack.json` is scanned by the phone apps, so it must not carry a provider URL with a key in it. The
stack binds `STACK_PORT` and forwards JSON-RPC POSTs to `RPC_URL`, logging nothing, and `stack.json`
names that address. Set `STACK_PUBLIC_RPC_URL` to hand the phones a provider that is safe to share and
skip the proxy.

### Browser link relay (E1 / L7)

Start the stack with `STACK_MIN_DEVICE_SECURITY_LEVEL=SOFTWARE yarn demo` to allow the local
browser origins on the member servers. Start the browser relay separately with
`yarn workspace integration-testbed relay`. It binds to
`127.0.0.1:4177` and writes a fresh session key to an operator-only file outside the repository.
Its path is printed; the file is deleted on shutdown. The public stack descriptor carries no key.

The wallet and member pages ask for this key once per tab. You can also open a page with
`#relayKey=<key>`; the page removes it from the address bar and keeps it in sessionStorage.
Member pages separately ask for their own member server key from `stack.secrets.json`, or accept
`#memberKey=<key>`. Keep these links private. All tabs holding the relay key are trusted
participants in that demo session. HTTP traffic is visible to the local network.

The relay accepts only authenticated reads, writes and acknowledgements. Each sender is claimed by
one wallet tab. Delivered messages are acknowledged and removed; unacknowledged messages and claims
expire after five minutes. Each queue holds at most 100 messages, bodies are capped at 16 KiB,
and link URLs at 2,000 characters. A full queue answers 429 rather than silently dropping work.

`LINK_RELAY_HOST`, `LINK_RELAY_PORT` and `LINK_RELAY_ORIGINS` configure an explicit listener and
comma-separated browser origins. Defaults allow localhost/127.0.0.1 on ports 4173–4176. LAN use
requires an explicit host and allowed origins. CORS checks are in addition to session authentication.
Mobile apps keep their existing deep-link/QR transport and do not use this relay. After restarting
the stack or relay, reopen the browser pages with their fresh pairing keys.
