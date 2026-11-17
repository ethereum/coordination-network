# @coordination-network/issuer-registry

An issuer registry in TypeScript: a [LeanIMT](https://zkkit.pse.dev/classes/_zk_kit_lean_imt.LeanIMT.html) of approved issuer commitments. Proving a credential came from an approved issuer, without revealing which one, means proving its issuer's commitment is **in** the tree; that Merkle proof is the witness a zero-knowledge circuit consumes.

The class reads and writes nothing external, so it works both as the authority (a server that approves issuers and publishes roots) and as a mirror of one held elsewhere, typically the on-chain [`IssuerRegistry`](../contracts/src/issuer-registry) contract. A mirror is trusted for **availability only**: compare `root` against the authority's root before using any proof built from it.

## Install

```bash
yarn add @coordination-network/issuer-registry
```

## Usage

```ts
import { IssuerRegistry } from "@coordination-network/issuer-registry"

// Admin
const registry = new IssuerRegistry(commitments) // in the authority's insertion order
registry.addIssuer(issuerCommitment) // publish registry.root

// Holder
if (registry.root !== publishedRoot) throw new Error("stale registry")
const proof = registry.generateProof(issuerCommitment) // { root, leaf, index, siblings }
```

The circuit must compute the leaf from the issuer's public key rather than take it as an input: leaves are not hashed, so an internal node would otherwise pass as a leaf one level up.

## Hash schemes

The registry is generic in its hash. An `IssuerScheme` supplies the internal-node hash and the `bound` every commitment must stay below. The registry, the contract and the circuit must all use the same scheme. Two are built in; `poseidonScheme` is the default:

| Scheme           | Node hash                             | Values      | Matches                                       |
| ---------------- | ------------------------------------- | ----------- | --------------------------------------------- |
| `poseidonScheme` | 2-input Poseidon over BN254           | `< p_BN254` | `IssuerRegistry`, `lean-imt.sol`              |
| `sha256Scheme`   | SHA-256 over 32-byte big-endian words | `< 2^256`   | `Sha256IssuerRegistry`, `lean-imt-sha256.sol` |

Snapshots and leaves do not record their scheme, so pass it everywhere:

```ts
const registry = IssuerRegistry.fromLeaves(leaves, sha256Scheme)
IssuerRegistry.import(snapshot, true, sha256Scheme)
IssuerRegistry.verifyProof(proof, sha256Scheme)
```

**Custom schemes.** Any hash works without changing this package:

```ts
const myScheme: IssuerScheme = {
    hash: (left, right) => myHash2(left, right),
    bound: MY_FIELD_ORDER,
    boundDescription: "my field order" // optional, for errors
}
```

The hash must accept every value below `bound` and every hash output.

## Rebuilding a registry

| Input                               | Rebuilds                | Notes                                                          |
| ----------------------------------- | ----------------------- | -------------------------------------------------------------- |
| `new IssuerRegistry(commitments)`   | Only if nothing removed | Removed issuers keep their slots, so replaying adds is lossy   |
| `IssuerRegistry.fromLeaves(leaves)` | Any registry            | From `leaves` or the contract's `getLeaf`; rehashes everything |
| `IssuerRegistry.import(snapshot)`   | Any registry            | From `export()`; validated by default                          |

Always compare `root` with the authority's afterwards: that is what catches missing, reordered or tampered data.

## Merkle siblings

`removeIssuer` and `updateIssuerCommitment` find the leaf themselves. The contract instead checks the siblings it is given against its current root, so pass them in, computed against the current state:

```ts
registry.siblingNodesOf(commitment) // removeIssuer, updateIssuerCommitment
```

## API

| Member                                                                              | Purpose                                                                |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `new IssuerRegistry(commitments?, scheme?)`                                         | Create a registry. `scheme` defaults to `poseidonScheme`.              |
| `root`, `depth`, `size`, `leaves`, `commitments`                                    | State. `root` is `0` while empty; `leaves` includes removed (`0`).     |
| `isIssuer(c)`, `indexOf(c)`                                                         | Lookups. `indexOf` is the leaf index, or `-1`.                         |
| `addIssuer(c)`, `addIssuers(cs)`, `removeIssuer(c)`, `updateIssuerCommitment(o, n)` | Writes, named as in the contract. `addIssuers` is all or nothing.      |
| `generateProof(c)`                                                                  | Membership proof.                                                      |
| `verifyProof(p)`, `IssuerRegistry.verifyProof(p, scheme?)`                          | Against this registry's root, or the proof's own root.                 |
| `siblingNodesOf(c)`                                                                 | Siblings for the contract's `removeIssuer` / `updateIssuerCommitment`. |
| `export()`, `import(s, validate?, scheme?)`, `fromLeaves(l, scheme?)`               | Snapshots and rebuilding.                                              |
| `toCommitment(v, scheme?)`, `toFieldElement(v, scheme?)`                            | Validate a commitment or field element.                                |
| `poseidonScheme`, `sha256Scheme`, `IssuerScheme`                                    | Built-in schemes and the scheme type.                                  |

## Notes

- Commitments must be non-zero (zero marks removed issuers) and below the scheme's `bound`.
- A removed issuer stays approved for verifiers still accepting an older root; the contract's `expireRegistryRoots` closes that window for a compromised key.
- `tests/cross-language.test.ts` pins Poseidon and SHA-256 roots against the contracts.
