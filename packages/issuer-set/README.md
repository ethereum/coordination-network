# @coordination-network/issuer-set

The approved-issuer set in TypeScript: a [LeanIMT](https://github.com/zk-kit/zk-kit) accumulator over the credential signing keys of approved network members, mirroring `ApprovedIssuerSet.sol`.

A verifier needs to know that whoever signed a credential was an approved issuer at the time. The set answers that with a single Merkle proof against a root everyone agrees on, and that proof is the witness a zero-knowledge circuit consumes to show the same thing without revealing which issuer signed.

Keys are Baby Jubjub public keys in affine form, `[x, y]`. Leaves and internal nodes are Poseidon hashes over the BN254 scalar field, domain-separated by `ISSUER_LEAF_DOMAIN`, which is what keeps this implementation, the Solidity one and the circuit in agreement.

## Install

```bash
yarn add @coordination-network/issuer-set
```

## Usage

### Building the set and proving membership

```ts
import { ApprovedIssuerSet } from "@coordination-network/issuer-set"

const set = new ApprovedIssuerSet(publicKeys)

if (!set.isApproved(issuerKey)) throw new Error("issuer is not approved")

const witness = set.generateProof(issuerKey)

// witness.root is what a verifier pins against the authority
```

Order matters. The tree is position-addressable, so the same keys inserted in a different order produce a different root. When rebuilding a set that already exists, supply the keys in the order that set published them.

### Rebuilding from the authority

The on-chain set is the authoritative copy.

```ts
const set = await ApprovedIssuerSet.fromContract({
    getLeafCount: () => contract.read.getLeafCount(),
    getLeaves: (start, end) => contract.read.getLeaves([start, end])
})
```

### Publishing and retiring keys

```ts
const leaf = set.publish(issuerKey) // must be in the prime-order subgroup, unlike the constructor
set.publishMany(issuerKeys)
set.retire(issuerKey) // tombstones the slot; leafCount never shrinks
```

### Verifying a proof

```ts
set.verifyProof(witness) // against this set's current root
ApprovedIssuerSet.verifyProof(witness) // against the root the witness carries
```

## Notes

- The set must not be empty, and it is capped at `2 ** ISSUER_SET_MAX_DEPTH` (depth 20) because that is the circuit's `binary_merkle_root` capacity. The tree's actual depth is dynamic and tracks `ceil(log2(leafCount))`.
