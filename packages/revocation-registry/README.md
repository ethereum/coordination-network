# @coordination-network/revocation-registry

A revocation registry in TypeScript: a [LeanIMT+](https://pse.dev/blog/lean-imt-plus-efficient-merkle-tree-for-membership-and-non-membership-proofs) whose leaves are the revocation commitments of revoked credentials.

Revoking a credential inserts its commitment. Proving a credential is still valid means proving its commitment is **absent** from the registry, which a single Merkle proof of the commitment's predecessor establishes. That proof is the witness a zero-knowledge circuit consumes to show the same thing without revealing which credential is being presented.

## Where the registry lives

`RevocationRegistry` is a complete implementation of the structure, not a client for a particular backend: it reads and writes nothing external. What changes between deployments is only which copy is authoritative.

### On chain, the intended deployment

[`contracts`](../contracts) holds the authoritative registry, and it is what the rest of this design assumes. It gives you three things that matter here:

- **Everyone sees the same root.** The chain settles it, so an issuer cannot show one root to one verifier and a different one to another, and a verifier checks any root it is handed with a single `isValidRoot` call.
- **The registry is readable without any service.** The full leaf table is on chain, so a holder can always rebuild the tree even if every indexer and snapshot host is down.
- **Every revocation is publicly auditable.** Each one is a transaction with a timestamp that anyone can inspect after the fact.

This package is the off-chain half of that deployment, in both directions. An issuer uses it to compute the predecessor index a revocation transaction needs. A holder uses it to rebuild the tree and generate a proof locally, which is what keeps presentation private: they read the whole public registry and never disclose which commitment they care about.

### In a server, which works the same way

Nothing here depends on the contracts, so a service can hold the authoritative registry itself: keep a `RevocationRegistry`, revoke into it, and publish the root and the leaf slots. Persist it with `export()` / `import()`, or rebuild it from your own records at startup. Holders then rebuild from what you publish and prove exactly as they would against a chain. The structure, the hashes and the proofs are identical: the same commitments applied in the same order produce the same root wherever the registry is held, which the cross-language tests in both packages pin against each other.

The one thing that changes is who a verifier trusts for the root. On chain that question is settled. With a server, a verifier accepting a root is taking the operator's word that it is the current one. Signing published roots helps, since it proves a root came from the operator, but it does not stop the operator handing one root to one verifier and a different one to another.

It also matters who runs the server. Every presentation needs someone to answer "is this root still valid?", and if the issuer runs the server, the issuer answers. It still cannot tell which credential is being presented, but it sees that one is, when, and who is asking, and presentations stop while the server is down. On chain the issuer is never involved.

### Either way

Only the authoritative copy is authoritative. Every other copy, including one you just rebuilt, is trusted for **availability only, never integrity**: compare `root` against the root the authority publishes before using a proof built from it.

## Install

```bash
yarn add @coordination-network/revocation-registry
```

## Usage

### Revoking

```ts
import { RevocationRegistry } from "@coordination-network/revocation-registry"

const registry = new RevocationRegistry(commitments)

registry.revoke(revocationCommitment)

// registry.root is the new revocation root to publish
```

Order matters. The tree is position-addressable, so the same commitments inserted in a different order produce a different root. When rebuilding a registry that already exists, supply the commitments in the order that registry inserted them.

### Proving a credential is not revoked

```ts
const registry = new RevocationRegistry(commitments)

// Only trusted for availability: pin it to the authority before using it.
if (registry.root !== publishedRoot) throw new Error("stale registry")

const proof = registry.generateProof(revocationCommitment)

// proof.proofType === 1 means the commitment is absent, so the credential is not revoked.
```

This package stops at the proof. Shaping it for a particular proving system belongs to whichever circuit consumes it.

### Rebuilding a registry

There are three ways to reconstruct a registry, and which one you need depends on whether anything has ever been un-revoked.

| Input                                  | Rebuilds                      | Use when                                                                      |
| -------------------------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| `new RevocationRegistry(commitments)`  | Registries with no tombstones | Nothing has ever been un-revoked                                              |
| `RevocationRegistry.fromLeaves(slots)` | Any registry                  | Always correct; the authority publishes `leafSlots`, or the chain's `getLeaf` |
| `RevocationRegistry.import(snapshot)`  | Any registry                  | You already hold a snapshot                                                   |

The constructor takes only the commitments that are still revoked, which is lossy. An un-revocation tombstones a slot, and a tombstoned slot still occupies a Merkle position, so replaying the surviving commitments produces a **different root** and every proof built from it fails. Nothing warns you except the root comparison.

`leafSlots` is the lossless view: every physical slot in index order, sentinel and tombstones included. It is exactly what the on-chain registry exposes as `getLeaf(registryId, i)` for `i` in `0..getRevocationTreeLeafCount(registryId) - 1`.

```ts
// Authority publishes
const slots = registry.leafSlots

// Anyone rebuilds the identical tree
const rebuilt = RevocationRegistry.fromLeaves(slots)
```

`fromLeaves` recomputes every hash from the slots rather than taking node data on trust, so unlike a snapshot there is nothing in the input to tamper with beyond the slots themselves. Compare `root` against the authority either way: that is what catches missing or reordered slots.

### Snapshots

Replaying every revocation since genesis gets slow. `export()` serializes the whole tree, hashes included, and `import()` rebuilds it without recomputing every node, so a service can publish periodic snapshots and a holder can sync from the latest one plus the few revocations after it.

`import()` validates by default: it rehashes the leaves against the serialized hashes and requires every leaf value to be a field element, which rejects a tampered snapshot. That is not proof of authenticity. Import a served snapshot with validation on, and compare `root` against the authority's.

A snapshot carries the node hashes, so it is larger than the leaf slots and lets a publisher hand you hashes you did not derive. `fromLeaves` is the leaner and more suspicious option; `import` is the faster one when you produced the snapshot yourself.

### Predecessor indices, for constrained backends

`revoke` finds a commitment's predecessor itself, so most callers never need these.

They exist because some authoritative implementations cannot afford to search. The on-chain registry is the example: it validates a caller-supplied predecessor index in `O(1)` rather than scanning, which is what bounds a write to `O(depth)` storage writes. Compute the index here and pass it in:

```ts
// Revoking one commitment
const lowLeafIndex = registry.lowLeafIndexOf(revocationCommitment)
// revocation.revoke(registryId, revocationCommitment, lowLeafIndex)

// Revoking a batch: each index is computed against the state after the earlier ones
const lowLeafIndices = registry.lowLeafIndicesOf(revocationCommitments)
// revocation.revokeMany(registryId, revocationCommitments, lowLeafIndices)

// Un-revoking, or replacing a commitment
const predecessor = registry.predecessorIndexOf(revocationCommitment)
// revocation.unrevoke(registryId, revocationCommitment, predecessor)
```

An index is only valid against the tree state the write applies to. If another revocation lands first, the on-chain call reverts with `InvalidLowLeaf` and the index has to be recomputed against the new state.

## API

| Member                                                               | Purpose                                                                               |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `new RevocationRegistry(commitments?)`                               | Create a registry, optionally pre-loaded. Order must match the authority.             |
| `root`, `depth`, `size`, `commitments`, `leaves`                     | Registry state. `root` is `0` while empty.                                            |
| `leafSlots`                                                          | Every physical slot, sentinel and tombstones included. Lossless.                      |
| `isRevoked(c)`, `indexOf(c)`                                         | Membership lookups.                                                                   |
| `revoke(c)`, `revokeMany(cs)`                                        | Insert commitments.                                                                   |
| `unrevoke(c)`, `updateCommitment(old, new)`                          | Undo or replace a revocation.                                                         |
| `generateProof(c)`                                                   | Membership (`proofType: 0`) or non-membership (`proofType: 1`) proof.                 |
| `verifyProof(p)`, `RevocationRegistry.verifyProof(p)`                | Against this registry's root, or against the proof's own root.                        |
| `lowLeafIndexOf(c)`, `lowLeafIndicesOf(cs)`, `predecessorIndexOf(c)` | Predecessor indices for backends that validate rather than search.                    |
| `export()`, `RevocationRegistry.import(s, validate?)`                | Snapshots.                                                                            |
| `RevocationRegistry.fromLeaves(slots)`                               | Rebuild any registry from its leaf slots, tombstones included.                        |
| `toCommitment(v)`, `toFieldElement(v)`                               | Coerce and validate a commitment, or any field element, against the registry's rules. |

## Notes

- Commitments must be non-zero and below the BN254 scalar field order. Zero is reserved for the sentinel leaf and for tombstones. Above the field order, two distinct values can reduce to the same field element, which would let one revocation silently cover an unrelated credential and would break the sorted ordering a non-membership proof relies on.
- Revocation is normally permanent. `unrevoke` exists because the structure supports it, but an un-revoked credential becomes valid again for every verifier still accepting an older root, and it leaves a tombstone that rules out rebuilding from `commitments` alone.
- `indexOf` returns a physical slot, never a position in `commitments`. The two always differ by at least one, because slot 0 is the sentinel.
- `revocationHashes` is the Poseidon pair every implementation of a registry must agree on: 3-input for leaves, 2-input for internal nodes. `tests/cross-language.test.ts` pins the resulting roots against the Solidity implementation.
