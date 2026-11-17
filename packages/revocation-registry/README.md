# @coordination-network/revocation-registry

A revocation registry in TypeScript: a [LeanIMT+](https://pse.dev/blog/lean-imt-plus-efficient-merkle-tree-for-membership-and-non-membership-proofs) of revoked credential commitments. Proving a credential is valid means proving its commitment is **absent**, which a Merkle proof of its predecessor establishes; that proof is the witness a zero-knowledge circuit consumes.

The class reads and writes nothing external, so it works both as the authority (a server that revokes and publishes roots) and as a mirror of one held elsewhere, typically the on-chain [`Revocation`](../contracts/src/revocation) contract. A mirror is trusted for **availability only**: compare `root` against the authority's root before using any proof built from it.

On chain, everyone sees the same root and the issuer is never involved in a presentation. With a server as authority, verifiers trust the operator for the current root, and the operator sees when presentations happen.

## Install

```bash
yarn add @coordination-network/revocation-registry
```

## Usage

```ts
import { RevocationRegistry } from "@coordination-network/revocation-registry"

// Issuer
const registry = new RevocationRegistry(commitments) // in the authority's insertion order
registry.revoke(revocationCommitment) // publish registry.root

// Holder
if (registry.root !== publishedRoot) throw new Error("stale registry")
const proof = registry.generateProof(revocationCommitment) // proofType 1: not revoked
```

## Hash schemes

The registry is generic in its hash. A `RevocationScheme` supplies the leaf and internal-node hash functions and the `bound` every commitment must stay below. The registry, the contract and the circuit must all use the same scheme. Two are built in; `poseidonScheme` is the default:

| Scheme           | Hashes                                | Values      | Matches                                              |
| ---------------- | ------------------------------------- | ----------- | ---------------------------------------------------- |
| `poseidonScheme` | Poseidon over BN254                   | `< p_BN254` | `Revocation`, the Noir credential circuit            |
| `sha256Scheme`   | SHA-256 over 32-byte big-endian words | `< 2^256`   | `Sha256Revocation`, `LeanIMTPlusSha256` in any field |

Snapshots and leaf slots do not record their scheme, so pass it everywhere:

```ts
const registry = RevocationRegistry.fromLeaves(slots, sha256Scheme)
RevocationRegistry.import(snapshot, true, sha256Scheme)
RevocationRegistry.verifyProof(proof, sha256Scheme)
```

**SHA-256 with field-element commitments.** `sha256Scheme` accepts any value below `2^256` unreduced. If commitments are field elements (e.g. Poseidon outputs), revoke the canonical value `c mod p`, and make the circuit enforce `value < p` when splitting into limbs, or a holder whose `c` is revoked can prove `c + p` absent. An issuer can enforce the bound on its writes without changing roots, since `bound` never checks hash outputs:

```ts
const issuerScheme = { ...sha256Scheme, bound: P }
```

Mirrors rebuilding from chain should keep `sha256Scheme`, since the contract accepts values `>= P`.

**Custom schemes.** Any hash works without changing this package:

```ts
const myScheme: RevocationScheme = {
    hashes: { leaf: (value, nextValue, tag) => myHash3(value, nextValue, tag), internal: (l, r) => myHash2(l, r) },
    bound: MY_FIELD_ORDER,
    boundDescription: "my field order" // optional, for errors
}
```

Both hashes must accept every value below `bound`, the internal hash must accept every hash output, and leaves must be domain-separated from internal nodes (by arity, length or tag).

## Rebuilding a registry

| Input                                  | Rebuilds                   | Notes                                                             |
| -------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| `new RevocationRegistry(commitments)`  | Only if nothing un-revoked | Tombstones keep their slots, so replaying is lossy                |
| `RevocationRegistry.fromLeaves(slots)` | Any registry               | From `leafSlots` or the contract's `getLeaf`; rehashes everything |
| `RevocationRegistry.import(snapshot)`  | Any registry               | From `export()`; validated by default                             |

Always compare `root` with the authority's afterwards: that is what catches missing, reordered or tampered data.

## Predecessor indices

`revoke` finds predecessors itself. Backends that validate instead of searching, like the contract, need them passed in, computed against the current state:

```ts
registry.lowLeafIndexOf(commitment) // revoke
registry.lowLeafIndicesOf(commitments) // revokeMany: each against the state after the earlier ones
registry.predecessorIndexOf(commitment) // unrevoke, updateCommitment
```

## API

| Member                                                                    | Purpose                                                                 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `new RevocationRegistry(commitments?, scheme?)`                           | Create a registry. `scheme` defaults to `poseidonScheme`.               |
| `root`, `depth`, `size`, `commitments`, `leaves`, `leafSlots`             | State. `root` is `0` while empty; `leafSlots` is the lossless view.     |
| `isRevoked(c)`, `indexOf(c)`                                              | Lookups. `indexOf` is a physical slot, not a position in `commitments`. |
| `revoke(c)`, `revokeMany(cs)`, `unrevoke(c)`, `updateCommitment(o, n)`    | Writes.                                                                 |
| `generateProof(c)`                                                        | Membership (`proofType: 0`) or non-membership (`proofType: 1`) proof.   |
| `verifyProof(p)`, `RevocationRegistry.verifyProof(p, scheme?)`            | Against this registry's root, or the proof's own root.                  |
| `lowLeafIndexOf`, `lowLeafIndicesOf`, `predecessorIndexOf`                | Predecessor indices.                                                    |
| `export()`, `import(s, validate?, scheme?)`, `fromLeaves(slots, scheme?)` | Snapshots and rebuilding.                                               |
| `toCommitment(v, scheme?)`, `toFieldElement(v, scheme?)`                  | Validate a commitment or field element.                                 |
| `poseidonScheme`, `sha256Scheme`, `RevocationScheme`                      | Built-in schemes and the scheme type.                                   |

## Notes

- Commitments must be non-zero (zero marks the sentinel and tombstones) and below the scheme's `bound`.
- Revocation is normally permanent: an un-revoked credential becomes valid again for verifiers still accepting an older root.
- `tests/cross-language.test.ts` pins Poseidon and SHA-256 roots against the contracts.
