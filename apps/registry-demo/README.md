# Registry demo

The on-chain registries driven against a local node, so each operation can be run and its result read
back.

Three flows, one command each.

| Flow                    | Command                         | What it shows                                                                       |
| ----------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| Network member registry | `yarn demo:network-member`      | How an organisation joins the network, publishes its keys, and leaves or is removed |
| Identity registry       | `yarn demo:identity`            | How an approved member registers, resolves, repoints and clears a user's identity   |
| The two together        | `yarn demo:member-and-identity` | What connects them, and what happens to a member's authority when it is removed     |

## Getting started

Requires [Foundry](https://getfoundry.sh) and Node. No Docker, and no circuit build.

```bash
yarn && yarn build:libraries && yarn build:contracts
yarn demo:network-member
yarn demo:identity
yarn demo:member-and-identity
```

Each deploys its contracts, runs the operations in order, and prints what changed on chain after every
one. Add `--step` to pause between steps and read as it goes:

```bash
yarn workspace @coordination-network/registry-demo start:network-member --step
```

Each run starts its own Anvil on port 8546 and kills it afterwards, so nothing is left behind and no
state carries between runs. The identity flow generates real Semaphore proofs, so its first run
downloads the proving artifacts (about 3.4MB, cached in the system temporary directory) and needs
network access for that once; after that a proof takes well under a second.

## What is and is not tested here

`yarn workspace @coordination-network/registry-demo test` runs all three walkthroughs, one after the
other, and fails if any step stops doing what its narration says. That works because each walkthrough
checks its own claims as it goes: every `ok` line is state read back from the chain, and a claim that
does not hold throws rather than printing a success. They share a port, so the test files run serially.

One test per flow is all this app needs. The contracts' behaviour is covered where it belongs, and is
not restated here in TypeScript:

- [`packages/contracts/test`](../../packages/contracts/test) covers authorisation, the governance rule
  and the atomicity of each operation, against a real Safe;
- [`packages/network-member-governance`](../../packages/network-member-governance) covers building,
  hashing and packing the Safe transactions;
- [`packages/network-member-proof`](../../packages/network-member-proof) covers what each membership
  proof commits to.

What neither of those can check is the part this demo is: that code putting transactions and proofs
together in TypeScript actually works against a real Safe and a real Semaphore group over a live
connection, with the group rebuilt from what the chain reports. Each existing test proves one piece in
isolation; running the demo proves the pieces fit.

## What it deploys

Both flows deploy the full governance stack, in the order production deploys it, ending in the state
the [onboarding runbook](../../packages/contracts/docs/configuration/network-member-onboarding.md) calls a founding
network: three founding members with records, group leaves and seats at a governance Safe that owns
everything. The identity flow adds one contract on top.

| Contract                  | What it holds                                                      |
| ------------------------- | ------------------------------------------------------------------ |
| Governance Safe           | The approver set. Owns the registry and the group                  |
| `NetworkMemberRegistry`   | Who is approved, and each member's keys                            |
| `NetworkMemberGroup`      | The Semaphore group of approved members                            |
| `NetworkMemberGovernance` | The orchestrator, enabled as a Safe module                         |
| `ApprovedIssuerSet`       | Members' credential signing keys, retired when a member is removed |
| `IdentityRegistry`        | Users' meta-stealth addresses. Identity flow only                  |

Three Safe transactions follow the deployment, each under a quorum, and none is optional.
`setApprovedIssuerSet` has to happen before anyone is admitted, because removal retires a member's keys
in the same call and refuses to run while the set is unwired: a member admitted first could never be
removed. `enableModule` has to happen because the orchestrator changes the Safe's own owner set, which
only an enabled module can make the Safe do. The genesis transaction then admits the founding members.

## Layout

The app holds one directory per flow, over shared plumbing. Each flow deploys what it needs and reuses
the steps the others define, so nothing is written twice.

```
scripts/
  shared/            config, artifacts, Anvil, Safe driving, narration, personas, group rebuild
  deploy/base.ts     Semaphore and the governance Safe, which every flow needs
  deploy/            one file per registry stack, composed onto the base
  network-member/    the member registry flow: six steps and the walkthrough that narrates them
  identity/          the identity registry flow: four steps, over the same deployment
  member-and-identity/  what only appears when both registries are deployed together
  run/               one command line entry per flow
tests/               one test per flow, each running its walkthrough
```

Each flow is `yarn demo:<flow>` from the repo root, and `start:<flow>` inside the app.

## The network member flow

Alice and Bob are prospective network members. Each holds an **auth key**, its account key,
whose public key its `networkId` hashes, and a **governance signer**, which becomes its seat at the Safe. They must be
different keys, and the registry enforces it: the auth key is a hot key that writes routine record
updates, and Safe ownership should not sit on a key used that way.

**1. The candidate announces itself.** `requestToJoin` is permissionless and stores nothing. It emits
the event approved members watch, carrying every argument the admission will make. The only check is
that the sender is the address of the account key it announces, so nobody can post a request for someone
else.

```ts
await requestToJoin(deployment, alice)
```

**2. A majority admits it.** Each approver reads the candidate's own event from the chain, builds the
transaction from it, and records an approval with `approveHash`. Nothing is circulated: identical
inputs give an identical digest, so independent approvals accumulate against one hash, and the member
whose approval completes the quorum submits `execTransaction`.

```ts
await admitMember(deployment, alice, [founders[0], founders[1]], mirror)
```

One call writes all three places an approved member exists, so a member is never approved without a
group leaf and never an approver without being a member. The threshold is not in the calldata: the
orchestrator computes it from the Safe's live owner count.

**3. Read the state back.** `readMember` gathers all three: the record, the group leaf, the Safe seat.

**4. The member publishes its own meta-stealth address.** Gated on its auth key rather than on
governance, so a member rotates its own address without asking a quorum. The same call registers and
updates, because the record is one slot the member overwrites.

```ts
await registerMemberIdentity(deployment, alice, metaStealthAddressFor(deviceSecret))
```

This is the members' own resolution path. Ordinary users resolve through the `IdentityRegistry`, a
different contract with a different authorisation model.

**5. A majority removes a member.** The mirror image of admission, and just as atomic: record, leaf,
seat and issuer keys all go, and the threshold comes down with the member count. Only the networkId is
passed, so a removal cannot be pointed at another member's leaf or seat.

**6. Or the member leaves.** `exitNetwork` is the one operation that does not go through the Safe,
because departure should not need the consent of the members being left. Only that member's own
governance signer can call it.

## The governance rule, on screen

Every step asserts the threshold, because it is the thing the whole design protects. A majority, one
more than half: three founding members need two signatures, and admitting Alice makes it four members
needing three. Removing a member hands it back. No operation anywhere takes a threshold argument.

The demo also shows the rule holding from the other side: a founder cannot reach the registry or the
group directly, cannot call the orchestrator, and a one-signature `execTransaction` is rejected by the
Safe itself with `GS020`.

## The identity registry flow

Dana is a user, not a member. She holds no governance keys and no seat anywhere: her `networkId` and
her meta-stealth address are both derived from her device, which is all a recipient's wallet has. Alice,
admitted in the flow above, registers her.

**1. A member registers the user.** Alice builds a proof for this exact registration, and the
transaction is sent by an account with no part in the network.

```ts
await registerIdentity(deployment, alice, dana, submitter)
```

**2. Anyone resolves it.** Reads are public, so a sender can route value to Dana without asking her for
anything. A networkId nobody registered resolves to null rather than failing.

```ts
await readIdentity(deployment, dana.networkId)
```

**3. The member repoints it.** Dana replaces her device, so her entry has to point at a new address. A
fresh proof, bound to the update action and the new address.

**4. And clears it.** A third proof, carrying no address because a removal writes none. The entry
resolves to nothing again and the networkId is free to be registered later.

## Who is allowed to write to the identity registry

This registry decides differently from the member registry, which is why the two flows are separate.

The member registry checks who is calling. Governance writes the parts that make you a member, and your
own key writes your own record. The identity registry never looks at who is calling. Instead, the
caller attaches an extra piece of data to the transaction, called a proof, and the contract checks that
instead.

The proof shows that an approved member is behind the change, without showing which member. That is the
part worth pausing on: the contract can tell the change came from someone on the approved list, and
still cannot tell who, because the proof reveals membership without revealing identity.

A proof covers one specific change and nothing else. It is built from the action being performed, the
user's networkId, the address being stored, the registry it is for, and the chain it is on. If any of
those differ when the transaction arrives, the proof no longer matches and the write is rejected. So a
proof built to register someone cannot be reused to update them, to store a different address, or at a
different deployment. The contract also records each proof as it is used and refuses it a second time.
[`@coordination-network/network-member-proof`](../../packages/network-member-proof) builds them, and
`scripts/identity/authorise.ts` is the whole of what this demo adds on top.

Since the contract ignores the sender, anyone can send the transaction. The walkthrough sends every
identity write from an account with nothing to do with the network: not a member, not an approver, not
in the group. It still works, which is the point. In production that sender would be a fresh stealth
address with the Semaphore paymaster paying its gas, so nothing on chain ties the change back to the
member who approved it; `apps/integration-testbed` shows that sponsorship in full.

## The two registries together

This flow does not repeat the other two, and it is not an end to end demo of the network: credentials,
stealth payments and sponsored execution are `apps/integration-testbed`'s job. It covers how these two
registries fit together, and nothing else. What it adds is the one thing the other two flows cannot
show on their own: that membership is what gives a member the authority to write to the identity
registry, and what happens to that authority when the membership ends.

Alice joins, registers Dana, and updates both registries: her own meta-stealth address with her auth
key, and Dana's entry with a proof. Then she builds two more proofs, submits neither, and governance
removes her.

**Her authority does not end at the vote.** A proof is checked against a group root, and Semaphore keeps
accepting a root for that group's window, an hour by default, measured from when the root became
current. So her proof registering Erin still lands after she is removed. That is deliberate: without it,
every write in flight would break each time governance admitted somebody. It is also why the
[runbook](../../packages/network-member-proof/README.md) says to treat a removal as effective an hour
after it rather than at the transaction that made it. The demo then advances the chain past the window
and shows her other proof, the one pointing Dana back, refused with `Semaphore__MerkleTreeRootIsExpired`.
She cannot build a replacement either, because her leaf is gone from the group she would have to prove
against, and the demo checks that too.

**What she registered is not hers.** Dana's entry survives Alice's removal, and a founding member clears
it afterwards with a proof of its own. The identity registry stores no link to the member that wrote an
entry, which is the same property that makes writes unlinkable in the first place.

## Rebuilding the group

Removing a member needs a Merkle proof for its leaf, and no contract can produce one: Semaphore keeps
the tree's root, not its leaves. So the tree has to be reconstructed off chain.

It is rebuilt every time a proof is needed, and nothing is kept between calls. A long-lived copy updated
as you go is only correct while you are the only party writing to the group, and the whole point of this
registry is that you are not: another member's admission landing between your proof and your transaction
leaves a cached copy quietly wrong.

The membership itself comes from [`@semaphore-protocol/data`](https://github.com/semaphore-protocol/semaphore/tree/main/packages/data),
which reads it from Semaphore's own membership events. Reading a Semaphore group is Semaphore's job, so
the demo does not carry a second implementation of it, and a member server would use the same reader.

What the demo does have to get right is turning that array into a tree. `getGroupMembers` returns the
leaves in index order with `"0"` where a member was removed, and passing it whole to the `Group`
constructor is what preserves the shape: a removal zeroes its leaf and leaves the slot in place, so a
tree built from only the current members would have the wrong shape and put everyone after the removal
at the wrong index. The constructor is the only way to do this, since `addMember` and `addMembers` both
refuse a zero. `rebuildGroupFromChain` then checks the result against the group's on-chain root before
returning it, so a tree that would produce rejected proofs fails at the point the mistake was made.

The demo shows both halves: after Bob is removed the rebuilt tree still has his slot, Alice is still at
her own index, and her voluntary exit in the next step succeeds using a proof computed from it.

## Notes

- **Gas comes from plain Anvil accounts.** Sponsorship buys nothing for the member registry, whose
  every write is authorised by `msg.sender` and so is inherently sender-bound. It would matter for the
  identity registry, where a fresh sender is what keeps a write unlinkable, and
  `apps/integration-testbed` demonstrates that path with the Semaphore paymaster.
- **A networkId is not free-form.** It is `keccak256(X || Y)` of the member's auth key, and the
  registry takes the key's coordinates rather than the id, so it derives the id and the auth address
  itself and an id has exactly one key behind it. The id is a hash, so it carries no case: no
  lower-casing is needed before filtering `getLogs` by it.
- **The founding members are admitted at deployment**, in the genesis transaction of the
  [runbook's phase 0](../../packages/contracts/docs/configuration/network-member-onboarding.md). Their calls go
  straight to the registry and the group rather than through the orchestrator, because their governance
  signers are already Safe owners and `admitMember` would try to add them a second time. So the group
  already holds three leaves before the walkthrough starts, and Alice's is the fourth.
