# @coordination-network/network-member-governance

The off-chain half of network member governance: build the Safe transaction that admits or removes a
network member, approve it on chain as one of the members, and pack the approvals into the call that
executes it.

Built on the Safe team's own [Protocol Kit](https://docs.safe.global/sdk/protocol-kit) primitives, so
the digest, the version handling, the MultiSend encoding and the signature packing are Safe's code, not
ours. What this package adds is the network member layer: turning an on-chain join request into the
exact call that admits it.

Admission is not a call any single party can make. The
[`NetworkMemberRegistry`](https://github.com/ethereum/coordination-network/blob/main/packages/contracts/src/NetworkMemberRegistry.sol) and
[`NetworkMemberGroup`](https://github.com/ethereum/coordination-network/blob/main/packages/contracts/src/NetworkMemberGroup.sol) are owned by the governance Safe, and
[`NetworkMemberGovernance`](https://github.com/ethereum/coordination-network/blob/main/packages/contracts/src/NetworkMemberGovernance.sol) turns each governance
operation into a single call only that Safe can make, so a member joins only when a majority of the
already-approved members has approved the same transaction. This package is what a member server runs to
take part: it never sends anything and holds no state, it turns a join request into the exact
transaction to approve, and turns a set of approvals into the one `execTransaction` call that lands it.

## Install

```bash
yarn add @coordination-network/network-member-governance
```

## The governance rule

A transaction needs a majority of the current members, one more than half: five members need three,
eight need five. A network may start from one founding member, where the majority is that member alone,
and may shrink back to one, but never to nobody: the last member cannot leave.

One and two members are bootstrap states, not operating ones. Majority rule tolerates
`floor((n - 1) / 2)` lost keys, so neither size survives a single loss, and a lost signer freezes the
network permanently. Two is the worse of the two: if one of the pair goes dark, admitting a third needs
its signature and so does removing it, so nothing can change again. The only way out is for the live member to depart, which hands the network to the key
that already stopped working. Three is the first size that survives a lost key. The
[runbook](https://github.com/ethereum/coordination-network/blob/main/packages/contracts/docs/configuration/network-member-onboarding.md) has the full trade-offs. The rule is computed on chain by `NetworkMemberGovernance.governanceThreshold`, and no
operation takes a threshold argument, so no module call can move it. Direct Safe calls can; the
[runbook](https://github.com/ethereum/coordination-network/blob/main/packages/contracts/docs/configuration/network-member-onboarding.md#the-governance-rule) lists the operating rules. `governanceThreshold(memberCount)`
here is the same expression for off-chain use: checking that a Safe is configured correctly, and
reporting what a pending operation will change the threshold to.

## The flow

A candidate announces itself with `requestToJoin`, which is permissionless. From there, every approved
member server does the same four things independently, with no coordinator and nothing circulated:

1. **Watch** `NetworkMemberJoinRequested` on the registry.
2. **Decode** the log into a request. `decodeJoinRequestLog` does the field mapping.
3. **Decide.** Vetting is your own code and lives outside this package: fetch the `metadataURI`, check
   the keys, apply whatever policy your organisation has. If the answer is no, stop here. Nothing you
   do or fail to do is visible on chain, and there is no vote against.
4. **Approve on chain** by building the transaction from the request and calling `approveHash` on the
   Safe. The member whose approval completes the quorum submits `execTransaction` instead, and the
   admission executes.

So a member never receives a transaction from anyone. Each approver derives the same bytes from the
same event, which is why the approvals add up: identical inputs give an identical `safeTxHash`.
Admission makes the new member an approver of the next candidate.

A candidate that holds its account key as a public key gets the request's key fields from
`memberAccountKey(publicKey)`, which accepts the 65-byte `0x04` form or the raw 64 bytes of `X || Y` and
returns `{ memberNetworkId, accountKeyX, accountKeyY }`.

### 1. Build the transaction from the request as the chain reported it

Building it from the event, rather than from what someone tells you, is what makes approving
meaningful: the digest you approve covers the account key, the Semaphore commitment and the governance
signer you just vetted. The `networkId` is `keccak256(X || Y)` of the account key, and the registry
derives it from the key's coordinates, so approving a key approves exactly one id.

```ts
import {
    NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
    buildAdmissionTransaction,
    decodeJoinRequestLog
} from "@coordination-network/network-member-governance"

const contracts = { governance, registry }
const context = { safeAddress, chainId } // add safeVersion for a Safe older than the SDK default

// The request comes from the candidate's own event, read from a node you trust and decoded here.
const logs = await client.getLogs({
    address: registry,
    event: NETWORK_MEMBER_JOIN_REQUESTED_EVENT,
    args: { memberNetworkId },
    fromBlock: REGISTRY_DEPLOY_BLOCK
})

// A candidate may publish several requests before it is admitted, so there can be more than one log
// here. `pickTheVettedRequest` is your own code: it must return the request your organisation actually
// vetted, not simply the newest, because approving an organisation is not the same as approving a set
// of keys. Store your decision against a hash of the account key, the commitment, the signer and the
// URI, and treat a later request as a new decision.
const admission = decodeJoinRequestLog(pickTheVettedRequest(logs), registry)

// The Safe's nonce, read from the chain.
const nonce = await client.readContract({ address: safeAddress, abi: safeAbi, functionName: "nonce" })
const owners = await client.readContract({ address: safeAddress, abi: safeAbi, functionName: "getOwners" })

const transaction = buildAdmissionTransaction(contracts, admission, context, Number(nonce), owners.length)
```

`contracts` is `{ governance, registry }`: the orchestrator, and the registry for reading records and
for a candidate's own join request. The result is one Safe transaction making one plain call to
`admitMember`. The owner count is pinned into that call so the transaction goes stale if the member set
changes before it executes: a voluntary exit shrinks the set through a module call, which does not
advance the Safe's nonce, so without the pin an in-flight signature set could reach a quorum it was
short of when signed. The orchestrator then writes the record, adds the group leaf, and has the Safe add the
new member's governance signer as an owner with the threshold it computes. All three land or none do,
and the threshold is never in the calldata.

**Every approver builds this independently, and that is the point.** The transaction is a pure function
of the on-chain request, the Safe's live owner set and the nonce, so independent builds are
byte-identical and hash to the same `safeTxHash`: approvals accumulate against one hash rather than
competing. What does compete is two different candidates at once, since both bind the same nonce; the
loser is rebuilt against the new nonce and approved again.

### 2. Approve it on chain

Every approver runs the same code, and it sends one or two transactions depending on where the quorum
stands when it runs.

- **`approveHash` always.** This is how you say yes: it records your approval in the Safe's own
  storage, from your own key.
- **`execTransaction` only if your approval completed the quorum.** Not a different way of
  approving, an extra step for whoever happens to be last. Every earlier approver stops after the
  first call.

Nobody knows in advance which one they will be, so both branches belong in every member's code.

```ts
import {
    checkQuorum,
    encodeApproveHash,
    encodeExecTransaction,
    hashSafeTransaction,
    onChainApproval
} from "@coordination-network/network-member-governance"

const txHash = hashSafeTransaction(context, transaction)

// Record your own approval. One transaction, from your own key.
await wallet.sendTransaction({ to: safeAddress, data: encodeApproveHash(context, txHash) })

// Then ask whether the quorum is now complete, counting yourself: as executor you occupy a slot
// without a prior approveHash, because the Safe counts the executor. Read the threshold from the
// Safe rather than computing it, since getThreshold is what it will enforce.
const threshold = await client.readContract({ address: safeAddress, abi: safeAbi, functionName: "getThreshold" })
const slots = [...approvers, myAddress]
const { hasQuorum } = checkQuorum(owners, Number(threshold), slots)

// Short of the quorum, you are done: your approval is on chain and a later member will submit.
// Submitting anyway would revert GS020, and naming an owner that never approved reverts GS025.
if (hasQuorum) {
    const calldata = encodeExecTransaction(context, transaction, slots.map(onChainApproval))
    await wallet.sendTransaction({ to: safeAddress, data: calldata })
}
```

`checkQuorum` counts distinct addresses that are current owners, so it answers whether the approvals you
read off the chain are enough. `onChainApproval` produces the pre-validated `SafeSignature` the Safe
accepts in place of a real one (`v = 1`, `r` = the owner, `s = 0`), which is what goes into the
`signatures` argument of `encodeExecTransaction`.

Reading who has approved needs chain access, so it is yours: either `approvedHashes(owner, txHash)` per
owner, or the Safe's `ApproveHash(bytes32 indexed hash, address indexed owner)` event. Filter to
addresses that are **still** owners, since an approval from a departed member fails `GS026` at
execution.

Nothing is ever circulated here, so there is no channel to secure, and no approver acts on a payload
another party assembled: the only bytes anyone approves are bytes they derived themselves from the
chain. Blind approval is not merely detectable but impossible, which is why there is no verification
step in this package: it would compare your own build against the request you built it from.

`encodeExecTransaction` encodes against the Safe ABI for the context's version, sorts the entries by
address as the Safe requires, and refuses a set that counts the same owner twice.

### Removing a member

Same shape, with the member's membership proof, which must be computed against the group state the
transaction will execute in:

```ts
import { buildRemovalTransaction } from "@coordination-network/network-member-governance"

const transaction = buildRemovalTransaction(
    contracts,
    { memberNetworkId, merkleProofSiblings },
    context,
    Number(nonce),
    owners.length
)
```

Just the networkId and the proof: the orchestrator reads the member's commitment and governance signer
from the registry, so a removal cannot be pointed at another member's leaf or seat. It lowers the
threshold with the member count and refuses to shrink the set below its floor. Approving it works
exactly as in section 2.

`admissionCall` and `removalCall` return the underlying meta-transaction, if you would rather assemble
the Safe transaction yourself. `buildSafeTransactionData` is what both builders use: one call goes
through as a plain call, and several are packed into a MultiSend batch, which is the only place this
package produces a delegate call. Governance never needs a batch, so both builders pass a single call.

### Leaving voluntarily

`encodeExitNetwork(memberNetworkId, merkleProofSiblings)` is calldata the member's own governance signer
sends **directly** to the orchestrator. Not a Safe transaction: departure needs no consent from the
members being left, so there is no transaction for anyone else to approve. It clears the member's record,
leaf and seat in one call, and hands the threshold back rather than leaving a seat nobody can sign for.

Only that member's governance signer can call it, so it reaches its own membership and no other.

## What this package does not do

- **It does not talk to a chain.** No RPC, no provider: only the Protocol Kit's pure helpers are used,
  never `Safe.init`. You read the join request event, the Safe's nonce and its owners, and you submit the
  calldata. `decodeJoinRequestLog` turns a log you fetched into a request, so the field mapping is not
  hand-rolled, but fetching it is yours.
- **It cannot tell where your inputs came from.** It builds a transaction from the request you hand
  it, and cannot know whether that request was read from a chain or invented. Fetching the event from a
  node you control is what makes your approval mean anything, and it is on you.
- **It does not decide anything.** Vetting a candidate is the approvers' judgement, and no code can
  check the one thing that matters most: whether the candidate already holds a member slot under
  another name. This package only encodes the decision.
- **It does not hold keys and sends nothing.** It returns calldata; submitting it from the member
  server's governance key is yours.
- **It supports one flow only.** Approvals are recorded on chain with `approveHash`, so there is
  nothing to distribute and no collector. Off-chain signing through the Safe Transaction Service or the
  Safe web UI is deliberately out of scope: it would put approvers in front of payloads other parties
  assembled, which is the risk this design removes. `signSafeTransaction` and `recoverSafeSigner`
  remain as Safe primitives, but no part of the flow uses them.

## Notes on correctness

- The digest comes from the SDK's `calculateSafeTransactionHash`, which is version-aware: Safe changed
  both the EIP-712 domain and the `SafeTx` struct before 1.3.0, so `safeVersion` in the context is what
  keeps the digest right on an older Safe. The tests still pin it against a hand-encoded oracle built
  from the literal Safe typehashes.
- The contracts package tests governance against the real Safe contracts
  (`@safe-global/safe-smart-account`): a proxy-factory deployment, a majority owner set, the
  orchestrator enabled as a module, and `execTransaction` with approvals packed exactly as this package
  packs them. A set that is short of quorum, or reused across transactions, is rejected by the Safe
  itself.
- The threshold is not something this package can get wrong, because it never sends one. It is computed
  on chain from the Safe's live owner count.
- Every approval is single-use: it covers the Safe's nonce, so executing any Safe transaction
  invalidates every approval recorded against that nonce. A voluntary exit is the exception, because it
  changes the owner set through a module call without advancing the nonce, which is exactly why the
  member count is pinned into every admission and removal.

## References

- [Network member onboarding and governance runbook](https://github.com/ethereum/coordination-network/blob/main/packages/contracts/docs/configuration/network-member-onboarding.md)
- [What is Safe](https://docs.safe.global/home/what-is-safe)
- [Protocol Kit: signing transactions](https://docs.safe.global/sdk/protocol-kit/guides/signatures/transactions)
