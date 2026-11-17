# Issuer registry contracts

On-chain issuer registries built on [LeanIMT](https://zkkit.pse.dev/classes/_zk_kit_lean_imt.LeanIMT.html). An admin approves issuers by publishing their commitments; a holder proves in zero knowledge that the issuer of their credential is in the registry, so the verifier learns an approved issuer signed it without learning which one.

## Contracts

| Contract                               | Role                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `IssuerRegistry`                       | Deployable service over Poseidon (BN254) trees.                                                      |
| `Sha256IssuerRegistry`                 | Deployable service over SHA-256 trees, for circuits over other fields (e.g. OpenAC over secq256r1).  |
| `PoseidonIssuerRegistries`             | Hash binding: owns the Poseidon trees. Inherit it to embed issuer registries in your own protocol.   |
| `Sha256IssuerRegistries`               | Hash binding: owns the SHA-256 trees.                                                                |
| `IssuerRegistryService`                | Policy: anyone can create a registry; each keeps a bounded history of accepted roots. Picks no hash. |
| `IssuerRegistries`                     | Hash-agnostic core: per-registry admins, writes, events and leaf values. Not inherited directly.     |
| `IIssuerRegistry`, `IIssuerRegistries` | Interfaces. Integrate against these.                                                                 |

A deployable combines one policy with one hash binding:

```solidity
contract IssuerRegistry is IssuerRegistryService, PoseidonIssuerRegistries { }
```

```text
issuer-registry/
├── interfaces/   shared
├── base/         shared: IssuerRegistries, IssuerRegistryService
├── poseidon/     PoseidonIssuerRegistries, IssuerRegistry
└── sha256/       Sha256IssuerRegistries, Sha256IssuerRegistry
```

## Hashes

The contract, the off-chain registry and the circuit must all use the same hash, or roots will not match:

| Deployable             | zk-kit package        | Values      | Off-chain scheme | Node hash                 |
| ---------------------- | --------------------- | ----------- | ---------------- | ------------------------- |
| `IssuerRegistry`       | `lean-imt.sol`        | `< p_BN254` | `poseidonScheme` | `Poseidon(left, right)`   |
| `Sha256IssuerRegistry` | `lean-imt-sha256.sol` | `< 2^256`   | `sha256Scheme`   | `sha256(left \|\| right)` |

Leaves are stored unhashed, and an unpaired node is promoted to its parent unchanged.

**The circuit must derive the leaf.** Since leaves are not hashed, an internal node is a valid "leaf" one level up. The circuit must compute the leaf from the issuer's public key (e.g. `Poseidon(x, y)`) rather than take it as a free input, so no one can prove membership of a node.

**SHA-256 with field-element commitments.** `Sha256IssuerRegistry` stores any non-zero `uint256` unreduced. If commitments are field elements, add the canonical value `c mod p`, and make the circuit enforce `value < p` when splitting the commitment into limbs.

## Usage

```shell
yarn add @coordination-network/contracts
```

**Verifying.** `isValidRoot` is the only on-chain call a verifier needs; the issuer never appears.

```solidity
import { IIssuerRegistry } from "@coordination-network/contracts/issuer-registry/interfaces/IIssuerRegistry.sol";

// after verifying the zk proof, which outputs the root it was built against:
require(issuerRegistry.isValidRoot(registryId, issuerRoot), "stale or unknown issuer root");
```

**Adding issuers.** `addIssuer` and `addIssuers` append; `addIssuers` is cheaper than separate calls, since each internal node is rehashed once per batch.

**Removing and rotating.** `removeIssuer` zeroes the issuer's leaf and `updateIssuerCommitment` rewrites it in place. Both take the commitment's Merkle siblings, which the library checks against the current root. Compute them with [`@coordination-network/issuer-registry`](https://github.com/ethereum/coordination-network/tree/main/packages/issuer-registry) against the current state; if another write lands first, the call reverts and the siblings must be recomputed.

```ts
const siblings = registry.siblingNodesOf(issuerCommitment)
// issuerRegistry.removeIssuer(registryId, issuerCommitment, siblings)
```

**Rebuilding the tree.** The LeanIMT keeps no leaf values, so `IssuerRegistries` stores them: reading `getLeaf(registryId, i)` for `i < getIssuerTreeSize(registryId)` and passing them to `IssuerRegistry.fromLeaves` rebuilds the tree without an indexer, and without asking an RPC provider for a particular issuer's path.

**Root history.** A superseded root stays accepted for `rootDuration` seconds (1 hour by default, per registry), so proofs in flight survive a new write. The window starts when a root stops being current, so a removed issuer keeps backing proofs for at most `rootDuration` after its removal. `rootDuration = 0` accepts only the current root.

**Compromised keys.** `expireRegistryRoots` rejects every root superseded so far at once, leaving only the current one. Remove the issuer, then call it, and no proof against a root that still contains the issuer verifies. Proofs other holders had in flight must be rebuilt.

## Build

```bash
yarn build:contracts
yarn test:contracts
```

## Notes

- Commitments must be non-zero (zero marks removed issuers) and within the hash's range.
- The empty root (`0`) is never valid: no membership proof exists against it.
- A removed issuer can be added again; it takes a new slot.
- Registries are isolated: an admin can only write to its own. Admin transfers are two-step.
- `updateIssuerCommitment` links the old and new commitments on chain; use `removeIssuer` plus a separate `addIssuer` if they must not look related.
- `test/integration/IssuerRegistryCrossLanguageRoot.t.sol` and `Sha256IssuerRegistryCrossLanguageRoot.t.sol` pin the roots against the TypeScript package.
