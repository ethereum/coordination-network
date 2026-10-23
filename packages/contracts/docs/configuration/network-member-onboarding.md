# Network member onboarding and governance runbook

How a network member is admitted, how it becomes an approver of the next one, and how it leaves or is
removed.

Four contracts are involved. Three hold the state that defines an approved network member, and one
turns each governance operation into a single call:

- [`src/NetworkMemberRegistry.sol`](../../src/NetworkMemberRegistry.sol): who is approved, and each
  member's keys. Member information only.
- [`src/NetworkMemberGroup.sol`](../../src/NetworkMemberGroup.sol): the Semaphore group of approved
  members. It creates the group on the Semaphore deployment in its own constructor, with itself as the
  group's Semaphore admin. Contracts that gate on membership read the group from Semaphore by
  `GROUP_ID` and never touch this one.
- **The governance Safe**: the approver set. It owns the other two contracts and its own owner set, so
  the network governs itself with no operator key anywhere.
- [`src/NetworkMemberGovernance.sol`](../../src/NetworkMemberGovernance.sol): the orchestrator. Callable
  only by the Safe, and enabled as a Safe module so it can reach the Safe's owner-set functions. It
  exposes exactly three operations, `admitMember`, `removeMember` and `exitNetwork`, each writing all
  the places that operation touches. The first two are the Safe's alone; the third is a member's own.
  It takes no threshold argument: it computes the threshold from the Safe's live owner count, so no
  module call can move it. Direct Safe calls can; see [the governance rule](#the-governance-rule).

## The governance rule

A transaction needs a **majority of the current members: one more than half**.

| members           | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | 10  |
| ----------------- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| signatures needed | 1   | 2   | 2   | 3   | 3   | 4   | 4   | 5   | 5   | 6   |

The floor is one, in both directions. A network may start with a single founding member and may shrink
back to one, so growth is reversible and a shrinking network is never trapped at a size it cannot leave.
What `MIN_MEMBERS` refuses is emptying the set: the last member cannot remove itself or depart, because
an ownerless Safe could never admit anyone again and would freeze the registry and the group behind it
with no path back.

Read the first column for what it is. The majority of one is one, so a single founding member is the
entire quorum: it can admit anyone, and nothing about the design constrains it. That is a bootstrap
state to leave promptly, not one to operate in.

This is the only threshold rule in the system. `NetworkMemberGovernance.governanceThreshold` computes
it, and every module operation sets the Safe's threshold from it. The Safe can still change its owners
and threshold directly, so the rule holds only if:

- owners and the threshold change only through the module, never through direct Safe calls such as
  `changeThreshold` or `swapOwner`, except to restore the threshold as below;
- every Safe owner is a network member;
- a signer is rotated by removing the member and admitting it again.

`admitMember` and `removeMember` revert with `ThresholdMismatch` while the Safe's threshold differs
from the one in the table above for its current number of owners: half the owners, rounded down,
plus one. This detects a changed threshold but cannot prevent one: until it is fixed, the Safe still
executes any direct transaction at whatever threshold it has. To fix it, a quorum calls
`changeThreshold` on the Safe directly with that number: for example, `changeThreshold(3)` for a Safe
with five owners.

Monitor `NetworkMemberExited` and any Safe owner or threshold change not made through the module.
Sequential exits can shrink the network down to one member.

The deploy script checks the same rule against the founding Safe, and
[`@coordination-network/network-member-governance`](../../../network-member-governance/README.md) carries
the same expression offchain.

## Roles and keys

| Party           | Key                                                    | What it can do                                                                                                                  |
| --------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Governance Safe | A majority of member governance signers                | Admit and remove members, add and remove group commitments, change its own owner set and threshold, and write any member record |
| Network member  | Its **governance signer**                              | Sign governance transactions as one owner of the Safe                                                                           |
| Network member  | Its **account key**, whose address is its auth address | Announce a join request; write its own meta-stealth address                                                                     |
| Anyone          | none                                                   | Read the approved set, the group root, and each member's published keys                                                         |

Each member holds four things:

- the **governance signer**, its seat at the Safe. It MUST NOT be the auth key: the auth key is a hot
  server key that signs routine record writes, and Safe ownership should not sit on a key used that
  way. The registry rejects a governance signer equal to the auth address, on the request path and on
  the approval path alike.
- the **account key**, a secp256k1 key whose address is the member's auth address. The auth address
  announces the request and writes the member's meta-stealth address. The `networkId` is
  `keccak256(X || Y)` of the key, and the registry takes the key's coordinates rather than the id:
  it rejects a pair that is not on the curve, derives the id and the auth address itself, and
  rejects a sender that is not that address, which makes the request itself proof of key possession.
  One key backs exactly one id.
- the **Semaphore identity commitment**, its leaf in the approved-member group.
- the **credential signing keys**, published into
  [`ApprovedIssuerSet`](../../src/ApprovedIssuerSet.sol) once the member is approved. Verifiers check
  credential issuance against that contract's root, not against anything this registry stores.

## Phase 0: bootstrap

The network starts with one founding member. Every later member joins through Phases 1 to 6.
[`deploy-and-configure-all.md`](../deployment/deploy-and-configure-all.md) runs all of Phase 0 in one
command:

```shell
yarn deployAndConfigureAll:sepolia --private-keys "$DEPLOYER_PRIVATE_KEY" --private-keys "$OWNER_PRIVATE_KEY" --sender "$DEPLOYER"
```

1. [`script/DeploySafe.s.sol`](../../script/DeploySafe.s.sol) creates the Safe with `OWNER`, the founding
   member's governance signer, as its only owner and a threshold of one. That network member alone is the
   quorum until it admits the next one.
2. [`script/DeployAll.s.sol`](../../script/DeployAll.s.sol) deploys the registry, the group and the
   orchestrator against the chain's Semaphore deployment.
   [`script/DeployNetworkMemberRegistry.s.sol`](../../script/DeployNetworkMemberRegistry.s.sol) refuses
   to deploy unless the governance address holds code, has at least one owner, and requires exactly
   the majority of them. An operator EOA, a token threshold, and unanimity are all rejected: unanimity
   would let one member veto every admission. `NetworkMemberGroup` creates the approved-member group in
   its constructor, so the group is created once and never later.
3. Verify: `owner()` is the Safe and `pendingOwner()` is zero on the registry and the group; the
   Semaphore group's admin is the `NetworkMemberGroup` address; `group.merkleTreeRoot()` is zero; and
   the orchestrator's `SAFE()`, `REGISTRY()` and `GROUP()` point at the right three addresses.
4. [`script/utils/ConfigureGovernance.s.sol`](../../script/utils/ConfigureGovernance.s.sol) sets the
   registry's `ApprovedIssuerSet` and enables the orchestrator as a Safe module, as Safe
   transactions the founding member signs. Until the module is enabled, every operation reverts with
   the Safe's `GS104`, so nothing half-lands.
5. **Record `group.GROUP_ID()`.** Every membership-gated contract is constructed with it, and it cannot
   be changed afterwards.
6. Admit the founding member's record and group leaf. Its governance signer already owns the Safe from
   step 1, so the admission goes directly to the registry and group rather than through the
   orchestrator, which would try to add the owner a second time.
   [`script/utils/AdmitNetworkMember.s.sol`](../../script/utils/AdmitNetworkMember.s.sol) does this for
   any signer that already owns the Safe.

### Founding sizes: one and two are transit states

A network may start with a single founding member and grow, and the deploy script allows it. What it
cannot do is make one or two members safe to stay at. Treat reaching **three** as part of bootstrap
rather than something that happens later.

**No fault tolerance until three.** Majority rule survives `floor((n - 1) / 2)` lost keys:

| members | threshold | keys you can lose and still govern |
| ------- | --------- | ---------------------------------- |
| 1       | 1         | 0                                  |
| 2       | 2         | 0                                  |
| 3       | 2         | 1                                  |

Two members is no safer than one here. And a lost signer is permanent: the registry and the group are
owned by a Safe that can never again reach its threshold, so the network is frozen for good.

**The two-member deadlock.** This is the trap worth naming. Start at one, admit a second member, and the
threshold becomes two. If that second member then goes dark, or its key turns out to be wrong:

- admitting a third needs two signatures, one of them the dark member's, so it cannot happen;
- removing the dark member needs the same two signatures, so that cannot happen either.

There is no path forward, and the one path back does not help: the live member cannot remove the dark
one, and while it could depart itself, that hands the whole network to the key that already stopped
working. At three members the same failure leaves two, which is the threshold, so the remaining pair can
both admit and remove.

**An anonymity set of one is not anonymous.** The Semaphore group exists so a member can prove that some
approved member acted, without revealing which. With one member in the group the proof identifies it
exactly: the group root is that member's commitment. With two it is a coin flip. The zero-knowledge
property only starts to mean anything as the group grows, which matters for anything gating on
membership.

**While at one member**, that member is the entire quorum: it admits whoever it likes and nothing in the
design constrains it. That is the honest cost of being able to bootstrap alone.

## Phase 1: the request, permissionless and onchain

The candidate calls, from the auth address of its account key:

```solidity
registry.requestToJoin(accountKeyX, accountKeyY, semaphoreCommitment, governanceSigner, metadataURI);
```

This stores nothing and grants nothing. It emits `NetworkMemberJoinRequested`, and no allowlist gates
it: only the holder of the account key can post a request for it, so nobody can request
on another member's behalf.

Every argument the later admission will carry is announced here. That is what lets an approver's
server build the admission from the candidate's own announcement rather than from anything a third
party says about it. Announcing them does not vouch for the candidate: the approvers still confirm
from the material at `metadataURI` that the candidate network member behind this `networkId` is who it claims to
be.

### About `metadataURI`

Where the approvers fetch the vetting material for Phase 2: who the candidate network member is, its key custody
and attestations, whatever the network has agreed it wants to see. The contract neither reads nor
stores it, and it is not one of the admission's arguments, so it feeds the human judgement in Phase 2
rather than the transaction built in Phase 3. It may be empty for a candidate that arranges vetting
entirely out of band.

The scheme is the network's choice and nothing in the contracts constrains it: an HTTPS URL, a
content-addressed URI, or anything else the members can all resolve. Pick one that will still resolve
in five years, and prefer a scheme with more than one independent implementation over one that depends
on a single project or company continuing to exist.

What matters more than the scheme is **integrity**: members must be sure the material they vetted is the
material the record refers to. Two ways to get that, in order of preference:

1. **Publish a digest of the material** alongside it, and have approvers check the bytes they fetched
   against it. This works with any scheme, including a plain HTTPS URL, and survives the hosting choice
   changing later.
2. **Use a URI that is itself a hash of the content**, which gets the same property for free but ties
   you to whatever addressing scheme you picked.

A bare mutable URL with no digest is the case to avoid: the material can be swapped between vetting and
signing, so members approve one document while the record points at another.

## Phase 2: vetting, offchain

Every approved member sees the event and checks, at minimum:

- that the candidate network member is who it claims to be;
- that the `networkId`, the Semaphore commitment and the credential signing key in the material belong
  to it;
- that the credential signing key lives in the KMS or HSM the material claims;
- that the governance signer is well-custodied, and is not a key the candidate network member also uses for
  something else;
- **that the candidate is not an entity that already holds a member slot under another name.** This is
  the check that actually protects the majority rule, and no code can do it.

Then record the decision, and record it **against these exact values** rather than against the
`memberNetworkId`. `requestToJoin` can be called repeatedly until a candidate is admitted, so one
candidate may have several requests onchain with different values in them. Pin the account key, the
commitment, the governance signer and the metadata URI you approved, and store a hash of them, so that a request published afterwards is a new decision rather than an inherited
one. Approving a candidate network member is not the same as approving a set of keys, and a server that verifies
transactions against "the newest request" will happily admit keys nobody vetted.

## Phase 3: building the transaction

There is no proposer, and nothing is circulated. Every approver builds the transaction itself, from the
request as the chain reported it, so the bytes it approves are bytes it derived rather than bytes
somebody handed it.

One Safe transaction, one plain call:

```solidity
governance.admitMember(accountKeyX, accountKeyY, semaphoreCommitment, governanceSigner, memberCount);
```

Every argument except `memberCount` comes from the `NetworkMemberJoinRequested` event, decoded with
`decodeJoinRequestLog` rather than mapped by hand. Read the event from a node the member controls: an
approval is only as meaningful as the source of the data it was built from.

The orchestrator then writes the record, adds the group leaf, and has the Safe call
`addOwnerWithThreshold` on itself with the threshold it computed. There is no MultiSend batch, no
delegate call, and no threshold in the calldata.

`memberCount` is the Safe's live owner count, and it is not a policy input: the threshold is still
computed, and this only pins the member set the transaction was built against. It exists because a Safe
evaluates a quorum at execution and relies on its nonce advancing to invalidate transactions signed
against an older owner set, while a voluntary exit changes that set through a module call, which does
not advance the nonce. Without the pin, three approvals the Safe had just rejected as short of a quorum
of four would execute the moment a departure made three a majority.

**Independent builds converge, and that is what makes this work.** The transaction is a pure function of
the onchain request, the Safe's live owner set and the Safe's nonce, so two approvers who build from
the same chain state produce byte-identical transactions and therefore the same `safeTxHash`. Approvals
accumulate against one hash without anyone coordinating.

What does compete is two _different_ candidates being admitted at once, because both bind the same nonce
and only one can execute. That is ordering, not authorship: the loser is rebuilt against the new nonce
and approved again. Serialize admissions when you can.

## Phase 4: approving onchain

Each approver computes the transaction hash and calls `safe.approveHash(txHash)` from its own key. That
call is how a member says yes, and it is the only thing an approver does until the quorum is complete.

Then it checks whether the quorum is now complete, counting itself, since the Safe counts the executor
as having approved. Read who has approved with `approvedHashes(owner, txHash)` per owner, or from the
Safe's `ApproveHash(bytes32 indexed hash, address indexed owner)` event, and filter to addresses that
are **still** owners: an approval from a departed member fails `GS026` at execution.

With a threshold of three that is two approval transactions and one execution. The cost is gas, one
transaction per approver rather than one for the whole quorum. What it buys is that **no approver ever
acts on a payload another party assembled.**

That property is worth being precise about, because it is the reason this is the only supported flow. A
quorum's signatures authorise whatever they cover, and the chain does not police the contents: the
orchestrator makes the admission itself tamper-proof, but a batch pairing `admitMember` with a rogue
call would execute just as happily if a quorum signed it.
`test_Governance_SafeStillExecutesWhateverTheQuorumSigned` in the contracts tests demonstrates this on
purpose. Circulating a payload for others to sign is what creates that opening, so nothing is
circulated, and blind approval becomes impossible rather than merely detectable. There is no
verification step in the governance package for the same reason: it would compare an approver's own
build against the request it built it from.

Approving through the Safe web app or the Safe Transaction Service is deliberately out of scope. Both
put approvers in front of transactions somebody else assembled, which is the risk this design removes.

## Phase 5: execution

The member whose approval completes the quorum submits `execTransaction` instead of stopping, naming the
approvers it read off the chain plus itself. Its own slot needs no prior `approveHash`, though recording
one anyway leaves an onchain trace that it approved, which a transaction that reverts or loses a race
does not.

Submitting short of the quorum reverts `GS020`, and naming an owner that never approved reverts `GS025`.
Once `t(n)` approvals exist, anyone submits: the approvals carry the authority, not the sender. All three
effects land atomically or none do, and a failure inside any of them bubbles back out with its own reason
rather than a generic one.

## Phase 6: confirmation

- `isApproved(memberNetworkId)` is true and `governanceSignerOf` is the expected signer;
- `group.hasNetworkMember(commitment)` is true and `group.merkleTreeRoot()` has moved;
- `safe.isOwner(governanceSigner)` is true and `safe.getThreshold()` is the new majority.

Admission carries no credential signing key: the member publishes those itself, into
`ApprovedIssuerSet`, once it is approved and before its first issuance. It also publishes its
meta-stealth address from its auth key with `registerNetworkMemberIdentity`, and it is now an
approver: its governance signer counts toward the quorum for the next candidate.

## Leaving voluntarily

A member does not need permission to leave. Its own governance signer calls, directly, with no
proposal and no quorum:

```solidity
governance.exitNetwork(memberNetworkId, merkleProofSiblings);
```

That clears its record, its leaf and its seat, and moves the threshold down with the member count. Only
that member's governance signer can call it, so it can act on its own membership and no other: a
member's signer is powerless against anyone else's. It takes no pinned member count, because it carries
no signatures that could go stale.

One consequence for approvals already onchain: a departure invalidates every admission and removal
transaction in flight, since those pin the member count. Everyone rebuilds against the new member count
and approves the new hash, and approvals recorded against the old one are simply never executed.

A two-member network may use this call, and it leaves the other member alone with a threshold of one.
That is a real option when a pair has deadlocked, and a serious one: the remaining member then controls
the network by itself, so treat it as a way out of a stuck pair rather than a routine departure. What
neither this call nor `removeMember` can do is empty the set, since the last member has nobody to hand
the network to.

Use this rather than going quiet. A seat nobody can sign for still counts toward the owner count, and
therefore toward the threshold everyone else has to reach: six members with one dead seat still need
four signatures from the five that can sign. Leaving properly hands the threshold back.

Two things to know before calling it. Rejoining means a new request and a new place in the group, so the
old leaf and anything referencing it are gone for good. And every credential the member issued stops
verifying the moment its record is cleared, so tell the holders first.

## Removing a member

If a network member is gone, no longer trusted, or has lost a key it cannot replace and will not leave
of its own accord, a majority removes it with one call:

```solidity
governance.removeMember(memberNetworkId, merkleProofSiblings, memberCount);
```

The commitment and the governance signer are read from the registry, so a removal cannot be pointed at
another member's leaf or another member's seat. `merkleProofSiblings` is the membership proof for the
member's leaf, computed offchain against the group state the transaction will execute in; if another
group write lands first, recompute it and approve the rebuilt transaction. The threshold moves down with the
member count, and the orchestrator refuses to shrink the set below `MIN_MEMBERS`, which is one, so
governance can be reduced to a single member but never to nobody.

Removal clears the member's record, its leaf and its seat, and its credentials stop verifying. A removed
network member rejoins by requesting again from Phase 1, with a fresh commitment and a new place in the
group.

## What this design does not protect against

- **Majority capture.** A majority can admit allies or remove the minority, since removal uses the
  same threshold. This is inherent to majority rule and cannot be fixed inside the Safe, which has one
  threshold for everything. The controls are procedural: vetting for entities holding more than one
  slot, a written policy that removals need cause, and the fact that every action is a public event. If
  structural protection is wanted, a delay module on owner-set changes is the lever, so a hostile
  action is visible before it takes effect. That is not implemented.
- **A lost or compromised governance signer.** There is no way to replace it in place, so the only
  response is removal, which costs that member its group slot and its credentials. The seat counts
  toward the threshold until then, so a dead seat makes the quorum harder to reach for everyone.
- **A quorum that approves something other than an admission.** Building from the chain makes this
  impossible for a member following this runbook, since it never sees a payload it did not derive. It
  remains possible for a member that abandons the flow and signs a batch handed to it out of band: the
  Safe would execute `admitMember` alongside whatever else that batch called. Only a Safe transaction
  guard would forbid the extra call outright, and that is not implemented; a quorum can remove a guard
  anyway.
- **A stolen governance signer.** With `exitNetwork` it can destroy that one member's membership, which
  is also the worst that member could do to itself. It reaches nobody else's, and one signature is not a
  quorum, so the blast radius is the member whose key was stolen. Custody the governance signer at least
  as carefully as the credential signing key.
- **A trusted RPC.** Every approver builds its transaction from what its node reports, so an endpoint
  that lies about the request event, the nonce or the owner set decides what the member approves.
  Members should read from their own node, or at least an independent provider.
- **A bug in the orchestrator.** It is a Safe module, so a flaw there is a full bypass of the quorum.
  It is small and has one authorization check, and that check deserves the most review of anything
  here.
- **A member that admits its own second identity.** Only vetting catches this.
