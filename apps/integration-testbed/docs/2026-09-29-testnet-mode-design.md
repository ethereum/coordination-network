# `yarn stack` against a deployed network (testnet mode)

Design for issue #56 (E11-4). Approved 2026-09-29; the genesis model was rebuilt 2026-10-14 for the
deployment the audit fixes introduced.

## Problem

`yarn stack` (`apps/integration-testbed/src/serve.ts`) is the harness the reference phone apps and
the dashboard run against. It spawns Anvil, deploys every contract, funds every account from
Anvil, runs an in-process bundler and three member servers, and writes `stack.json`. The contracts
can be deployed on Sepolia with the runbook, and the SDK-level end-to-end runs there, but nothing lets
the stack, and so the phones, use that deployment.

## Scope

In: a testnet mode of the stack that deploys nothing; a one-shot genesis for the demo network on a
deployment made with `deployAndConfigureAll`; the hardening a public chain needs in the member servers,
the dashboard and `--check`; a CI job that exercises the deployment-file path on Anvil with the forge
scripts; docs.

Out: the web apps (stale against today's `stack.json`), the delivery flow in the apps (spec flow 6,
WS2; covered at SDK level), contract and deploy-script changes, SDK changes, hosted member servers.

## Decisions

- One switch, `TESTBED_MODE=testnet`. `serve.ts` has a seam: `resolveLocalStack()` (the Anvil path) and
  `resolveTestnetStack()` both return the same `ResolvedStack` (chain, addresses, deploy block, group
  id, Safe version, members, log window, public RPC URL, the paymaster mirror's settings); member
  servers, bundler, dashboard and `stack.json` run off it.
- Testnet mode reads `deployments/<chainId>.json` or `DEPLOYMENT_FILE`, the pinned third-party
  addresses (`config.ts`), `RPC_URL`, `OWNER_PRIVATE_KEY`, `STACK_BUNDLER_PRIVATE_KEY` and
  `STACK_MEMBER_SEEDS`. It mutates nothing at startup: a read-only preflight refuses to start with one
  precise line per unmet condition (chain id, code at every address, the registry answering
  `memberNetworkIdOf`, module enabled and issuer set wired, paymaster group admin, each founder admitted, in
  both groups, seated at the Safe, registered under its derived governance signer and publishing its
  own issuer key, the threshold against the governance rule, balances, the paymaster deposit, one
  `eth_getLogs` window against the provider).
- The registry check is how a deployment older than the account-key contracts is caught: its registry
  has no `memberNetworkIdOf`, and the line says to point `DEPLOYMENT_FILE` at a deployment of this branch.
- The bundler is the testbed's in-process one, signing with `STACK_BUNDLER_PRIVATE_KEY`, which is
  required so that no fresh key needs funding from `OWNER`. The phones keep `rpcUrl` on the stack host's
  8545 through a POST-only JSON-RPC proxy to `RPC_URL`, so the device runbook is unchanged and no keyed
  URL reaches a phone; `STACK_PUBLIC_RPC_URL` bypasses the proxy.
- Every listener binds `STACK_HOST`, default loopback. The dashboard holds every org's member server
  token and sends permanent transactions, so a deployed network is not put on the LAN unless the
  operator names it.
- Org wallet and governance signer keys derive from each member seed in both modes, so Safe seats and
  funded accounts survive restarts. The member server token stays random per run.
- `stack.json` keeps its shape; both phone apps parse it strictly. Only values change.
- Log reads are windowed and incremental: the member-group mirrors take a window, join requests and the
  dashboard's event sets are tailed by an `EventLogIndex`, the paymaster mirror polls the member group's
  `NetworkMemberAdded` and `NetworkMemberRemoved` logs from the deploy block, and the dashboard caches
  its state for a TTL. `STACK_LOG_WINDOW_BLOCKS` defaults to 10 000.
- `--check` on testnet skips the admission story unless `--check-admission`: admission is one-way and
  raises the Safe's owner count. CI runs it with the flag on Anvil.

## Genesis on a `deployAndConfigureAll` deployment

The runbook's `deployAndConfigureAll` deploys the contracts, wires the governance module and the issuer
set, funds the paymaster and admits a founding member whose Safe seat and governance signer is `OWNER`.
The Safe's owners are `[OWNER]` at threshold 1, `OWNER` also owns the paymaster and is its group admin,
and the deployer is never an owner. The zero revocation root has a grace window, so the tree is not
seeded.

`NetworkMemberGovernance.admitMember(x, y, commitment, signer, expectedMemberCount)` reverts unless the
Safe's owner count equals `expectedMemberCount` and its threshold equals `governanceThreshold(owners)`.
Genesis therefore admits Member A and then Member B one at a time, building each transaction against the live
owner count, cross-checking its hash against the Safe's own, collecting `approveHash` from the keys it
holds until the quorum is met and executing with the on-chain approvals:

| Step                                    | Owners before          | Signers               | After                 |
| --------------------------------------- | ---------------------- | --------------------- | --------------------- |
| Admit Member A                          | `[OWNER]`, threshold 1 | `OWNER`               | 2 owners, threshold 2 |
| Admit Member B                          | 2 owners, threshold 2  | `OWNER` and Member A  | 3 owners, threshold 2 |
| Candidate (phones, `--check-admission`) | 3 owners, threshold 2  | Member A and Member B | 4 owners, threshold 3 |

Before any of that it tops up the three org accounts, both founders' governance signers and the bundler
from `OWNER`, and the paymaster's deposit through `EntryPoint.depositTo` only below its target, never
its stake. After the admissions it publishes each founder's own issuer key from that org's auth key when
it is missing, and reconciles the paymaster group once so Member A, Member B and the founding member are in it.
`OWNER` is never removed: its seat is the founding member's.

Every step reads the chain first and does only what is missing, and every refusal comes before the first
transaction: a threshold off the rule (name `changeThreshold`), held keys that cannot reach a later
admission's threshold, a founder at the eight-key cap without its own leaf. The genesis preflight adds
the governance signer a founder is registered under (a reused founding-member secret would give another),
that `OWNER` is some approved member's governance signer (else `deployAndConfigureAll` was not used),
and that `OWNER`'s balance covers the remaining top-ups plus 0.05 ETH for gas: about 0.50 ETH on a
fresh network (five accounts at 0.05, the bundler at 0.2, the margin), plus up to 0.05 ETH for a low
deposit, on top of what `deployAndConfigureAll` spends.

Genesis sets the network up once and is rerun to refill; a rerun sends only what is missing. It does not
run while the stack serves, because both sign as `OWNER`. A relative `DEPLOYMENT_FILE` resolves from the
repository root, since `yarn stack:*` runs from `apps/integration-testbed`. In the serve scope a founder
missing from the paymaster group and a Safe grown past the stack's seats are warnings (the mirror adds
the founder at start; the five flows do not need the seats), while a founder without any seat still
fails. `--check-admission` resumes after a request with no or one approval (if both approvals landed, finish
from the dashboard) and refuses, before it spends, when the
stack's seats cannot reach the threshold. A testnet `--check` spends three sponsored registrations, a
sponsored delivery and a sponsored revocation.

## Acceptance

Spec flows 1 to 5 from the phones against Sepolia: identity; sponsored registration through Member A;
issuance; presentation at Member B; revocation from the dashboard and a rejected re-check; dedup at Member B;
then the candidate's admission by Member A and Member B. `serve --check` green in testnet mode without the
admission block. The CI job proves forge JSON, then the deployment file, preflight, genesis (twice, the
second sending nothing) and the full `--check-admission` story on Anvil.

## Follow-ups (filed separately)

Stale web apps; `--demo` flag ignored; fixed 1 gwei user-op fee and gas limits in `sponsored-relay.ts`;
`SemaphoreGroupClient` re-scanning from `fromBlock` on every proof; third-party addresses missing from
the deployment file; a `--reset-candidate` over `exitNetwork`.
