# Revocation contracts

On-chain revocation registries built on [LeanIMT+](https://pse.dev/blog/lean-imt-plus-efficient-merkle-tree-for-membership-and-non-membership-proofs). An issuer revokes a credential by publishing its commitment; a holder proves in zero knowledge that their commitment is _absent_, so the verifier never learns which credential was presented.

## Contracts

| Contract                               | Role                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `Revocation`                           | Deployable service over Poseidon (BN254) trees.                                                      |
| `Sha256Revocation`                     | Deployable service over SHA-256 trees, for circuits over other fields (e.g. OpenAC over secq256r1).  |
| `PoseidonRevocationRegistries`         | Hash binding: owns the Poseidon trees. Inherit it to embed revocation in your own protocol.          |
| `Sha256RevocationRegistries`           | Hash binding: owns the SHA-256 trees.                                                                |
| `RevocationService`                    | Policy: anyone can create a registry; each keeps a bounded history of accepted roots. Picks no hash. |
| `RevocationRegistries`                 | Hash-agnostic core: per-registry admins, writes and events. Not inherited directly.                  |
| `IRevocation`, `IRevocationRegistries` | Interfaces. Integrate against these.                                                                 |

A deployable combines one policy with one hash binding:

```solidity
contract Revocation is RevocationService, PoseidonRevocationRegistries { }
```

```text
revocation/
├── interfaces/   shared
├── base/         shared: RevocationRegistries, RevocationService
├── poseidon/     PoseidonRevocationRegistries, Revocation
└── sha256/       Sha256RevocationRegistries, Sha256Revocation
```

## Hashes

The contract, the off-chain registry and the circuit must all use the same hash, or roots will not match:

| Deployable         | zk-kit package             | Values      | Off-chain scheme | Circuit                                 |
| ------------------ | -------------------------- | ----------- | ---------------- | --------------------------------------- |
| `Revocation`       | `lean-imt-plus.sol`        | `< p_BN254` | `poseidonScheme` | Poseidon LeanIMT+ over BN254            |
| `Sha256Revocation` | `lean-imt-plus-sha256.sol` | `< 2^256`   | `sha256Scheme`   | `LeanIMTPlusSha256` (circom), any field |

SHA-256 leaves are `sha256(value || nextValue || 1)` and nodes `sha256(left || right)` over 32-byte words.

**SHA-256 with field-element commitments.** `Sha256Revocation` stores any non-zero `uint256` unreduced, since it cannot know the circuit's field. If commitments are field elements (e.g. Poseidon outputs) rather than SHA-256 digests:

1. Revoke the canonical value `c mod p`, or the revocation never matches what the circuit computes.
2. The circuit must enforce `value < p` when splitting the commitment into `[hi, lo]` limbs. Otherwise a holder whose `c` is revoked can prove `c + p` absent (possible for any commitment under BN254).

Off chain, an issuer can enforce this with `{ ...sha256Scheme, bound: p }`, which leaves roots unchanged. Mirrors rebuilding from chain should keep `sha256Scheme`.

### Adding a hash

1. Add the hash's zk-kit LeanIMT+ package to `package.json` and `foundry.toml` remappings.
2. Copy `poseidon/PoseidonRevocationRegistries.sol` to `<hash>/<Hash>RevocationRegistries.sol` with the new package.
3. Add `<hash>/<Hash>Revocation.sol`: `contract <Hash>Revocation is RevocationService, <Hash>RevocationRegistries { }`.
4. Run the shared suites against it (see `test/unit/Sha256Revocation.t.sol`) and pin its roots against the TypeScript scheme (see `test/integration/Sha256CrossLanguageRoot.t.sol`).
5. Add a deploy script.

## Usage

```shell
yarn add @coordination-network/contracts
```

**Verifying.** `isValidRoot` is the only on-chain call a verifier needs; the commitment never appears.

```solidity
import { IRevocation } from "@coordination-network/contracts/revocation/interfaces/IRevocation.sol";

// after verifying the zk proof, which outputs the root it was built against:
require(revocation.isValidRoot(registryId, revocationRoot), "stale or unknown revocation root");
```

**Revoking.** Writes take the predecessor's physical index, validated in `O(1)` instead of searched for. Compute it with [`@coordination-network/revocation-registry`](https://github.com/ethereum/coordination-network/tree/main/packages/revocation-registry) against the current state; if another write lands first, the call reverts and the index must be recomputed.

```ts
const lowLeafIndex = registry.lowLeafIndexOf(revocationCommitment)
// revocation.revoke(registryId, revocationCommitment, lowLeafIndex)
```

`revokeMany` is cheaper than separate revocations, since each internal node is rehashed once per batch.

**Root history.** A superseded root stays accepted for `rootDuration` seconds (1 hour by default, per registry), so proofs in flight survive a new revocation. The window starts when a root stops being current, so a revoked credential keeps verifying for at most `rootDuration` after its revocation. `rootDuration = 0` accepts only the current root.

## Build

```bash
yarn build:contracts
yarn test:contracts
```

## Notes

- Commitments must be non-zero (zero marks the sentinel and tombstones) and within the hash's range.
- There is no on-chain Merkle proof verifier: a plaintext proof would reveal the commitment, and `isRevoked` already answers that question.
- Registries are isolated: an admin can only write to its own. Admin transfers are two-step.
- `unrevoke` and `updateRevocationCommitment` are for correcting mistakes, and are public. `updateRevocationCommitment` links the old and new commitments; use `unrevoke` plus a later, separate `revoke` if they must not look related.
- `test/integration/CrossLanguageRoot.t.sol` and `Sha256CrossLanguageRoot.t.sol` pin the roots against the TypeScript package.
