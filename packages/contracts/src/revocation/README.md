# Revocation contracts

On-chain revocation registries built on [LeanIMT+](https://pse.dev/blog/lean-imt-plus-efficient-merkle-tree-for-membership-and-non-membership-proofs).

An issuer revokes a credential by publishing its revocation commitment. A holder proves their credential is still valid by proving, in zero knowledge, that their commitment is _absent_ from the registry. The verifier never learns which credential was presented, and never contacts the issuer.

## Contracts

| Contract                               | Role                                                                                                                                                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RevocationRegistries`                 | Abstract base. Owns one LeanIMT+ per registry, gates writes behind a per-registry admin, and exposes the reads a holder rebuilds the tree from. Inherit it to put revocation inside your own protocol. |
| `Revocation`                           | Deployable service on top of the base. Anyone can create a registry and become its admin, and each registry keeps a bounded history of accepted roots.                                                 |
| `IRevocationRegistries`, `IRevocation` | Interfaces. Integrate against these.                                                                                                                                                                   |

The split exists so the primitive and the policy can vary independently. `RevocationRegistries` owns the data structure and the access control that every revocation service needs. `Revocation` adds one particular policy on top: open registry creation and a bounded root history. A protocol that wants different policy, such as registries created only by governance or roots accepted on a different rule, inherits the base and writes its own.

## Usage

```shell
yarn add @coordination-network/contracts
```

### Integrating

```solidity
import { IRevocation } from "@coordination-network/contracts/revocation/interfaces/IRevocation.sol";

contract MyVerifier {
    IRevocation public immutable revocation;

    function verify(uint256 registryId, uint256 revocationRoot, bytes calldata zkProof) external view {
        // 1. verify the zero-knowledge proof; it outputs the revocation root it was built against
        // 2. check that root is one this registry currently accepts
        require(revocation.isValidRoot(registryId, revocationRoot), "stale or unknown revocation root");
    }
}
```

`isValidRoot` is the only on-chain read a privacy-preserving verification needs. The commitment never appears, which is what keeps presentations unlinkable.

### Revoking

Every mutation takes the physical index of the affected leaf's predecessor. The library validates that index in `O(1)` but does not search for it, which is what keeps a write at `O(depth)` storage writes. Compute it off chain with [`@coordination-network/revocation-registry`](https://github.com/ethereum/coordination-network/tree/main/packages/revocation-registry):

```ts
const lowLeafIndex = tree.lowLeafIndexOf(revocationCommitment)
```

then

```solidity
revocation.revoke(registryId, revocationCommitment, lowLeafIndex);
```

The index is only valid against the tree state the transaction executes in. If another revocation lands first the transaction reverts and the index must be recomputed.

`revokeMany` rehashes each affected internal node once for the whole batch instead of once per commitment, so a batch costs less than the same revocations sent one at a time, and the saving grows with batch size.

### The root history

A holder builds their proof against the root they last saw. A revocation landing between proof generation and verification would otherwise invalidate an honest proof, so each registry keeps accepting a superseded root for `rootDuration` seconds (one hour by default, configurable per registry).

The current root never expires; it is accepted for as long as it stays current, however long that is. When a revocation replaces it, the registry stamps that moment and the old root remains acceptable for `rootDuration` seconds from then. Every root therefore gets the same window, starting when it stops being current, which is exactly the interval in which a proof built against it can still be in flight.

This also bounds the risk the window creates. A credential revoked at some moment is absent from every earlier root and present in every later one, so the newest root that still lets it verify is the one its own revocation replaced. That root expires `rootDuration` seconds later, and older roots were superseded earlier and expire sooner. A revoked credential can therefore keep verifying for at most `rootDuration` after its revocation, whatever the registry's history.

`rootDuration` may be zero, which turns the grace period off: only the current root is accepted, and every proof in flight when a revocation lands is invalidated. That is the strictest setting, for a registry where a credential revoked seconds ago must not be presentable at all, and it costs failed presentations an honest holder cannot avoid. The comparison is strict on both ends, so a zero window rejects a root superseded in the same block rather than leaving a one-timestamp gap.

## Build

The contracts are deployed and tested inside the
[coordination-network](https://github.com/ethereum/coordination-network) monorepo, in the
`coordination-network-contracts` Foundry project:

```bash
yarn build:contracts
yarn test:contracts
```

## Notes

- Commitments must be non-zero and below the BN254 scalar field order. Zero is reserved for the sentinel leaf and for tombstones.
- There is deliberately no on-chain Merkle proof verifier. Verifying a plaintext proof would reveal the commitment, and a caller willing to do that can just call `isRevoked`, which is cheaper and answers the same question. The private path is a zero-knowledge proof verified elsewhere, whose root is checked with `isValidRoot`.
- Registries are isolated. One deployment serves many issuers, and an admin can only write to its own registry.
- Admin transfers are two-step, so a typo cannot strand a registry.
- `unrevoke` and `updateRevocationCommitment` are for correcting mistakes, such as a commitment revoked in error or an invalid value written to the tree. Like every write here, they are visible to anyone reading the chain. `unrevoke` shows that a commitment is no longer revoked. `updateRevocationCommitment` shows the old and new commitments together, so an observer can tell one replaced the other. Whether that link reveals anything depends on how the commitments are generated and handled in your use case. If two commitments should not appear related, use `unrevoke` and a separate `revoke` instead, spaced apart in time, since two writes landing back to back can be linked by their timing alone.
- `test/integration/CrossLanguageRoot.t.sol` pins the contract's roots against the TypeScript package. Any drift in the hashing or the insertion rules fails a test on both sides.
