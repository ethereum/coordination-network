# @coordination-network/contracts

The coordination network's core contracts.

- `NetworkMemberRegistry`: the approved-network-member set, and each member's identity, Semaphore
  commitment, credential signing key and governance signer. Member information only.
- `NetworkMemberGroup`: the Semaphore group of approved members, created on the Semaphore deployment
  at construction and administered by this contract.
- `NetworkMemberGovernance`: the orchestrator. One call per governance operation (admit, remove, exit),
  callable only by the Safe and enabled as a Safe module. It computes the majority threshold itself, so
  no caller can carry a wrong one, and it refuses to shrink the member set to nobody.
- `IdentityRegistry`: resolves a self-sovereign user's networkId to its meta-stealth address.
- `CredentialRevocationRegistry`: the network's one revocation registry. A single tree for every
  revoked credential, whoever issued it, held on a standalone [`Revocation`](revocation/README.md)
  deployment.
- `ApprovedIssuerSet`: the issuer set the credential circuit proves against.
- `SemaphorePaymaster`: an ERC-4337 paymaster that sponsors a user operation against a Semaphore
  membership proof.
- `test/ERC5564Announcer`: a copy of the canonical stealth-address announcement contract, deployed
  only by tests and local stacks.

The [revocation registries](revocation/README.md) ship in this package too: `CredentialRevocationRegistry`
imports them directly.

The governance Safe is the sole writer of the first two, and admission requires a majority of the
current members: admitting one adds its governance signer to the Safe, so the network governs itself.
See the
[network member onboarding and governance runbook](https://github.com/ethereum/coordination-network/blob/main/packages/contracts/docs/configuration/network-member-onboarding.md).

One command deploys every contract with the governance Safe as owner, enables the orchestrator as a
Safe module and admits the founding member. The
[deployment runbook](https://github.com/ethereum/coordination-network/blob/main/packages/contracts/docs/deployment/deploy-and-configure-all.md)
covers keys and funding:

```shell
yarn deployAndConfigureAll:sepolia --private-keys "$DEPLOYER_PRIVATE_KEY" --private-keys "$OWNER_PRIVATE_KEY" --sender "$DEPLOYER"
```

## Installation

```shell
yarn add @coordination-network/contracts
```

```solidity
import { IdentityRegistry } from "@coordination-network/contracts/IdentityRegistry.sol";
```

## Who can write to the IdentityRegistry

Reads are public and ungated. Every write, `registerIdentity`, `updateIdentity` and `removeIdentity`, is authorised by a Semaphore membership proof against the approved-member group, bound to the exact update it carries. No address-based write path remains: nothing reads `msg.sender`, there is no owner or allowlist path into the identity mapping, and there is no emergency override. Fixing a bad row means a member submitting a corrective `updateIdentity` or `removeIdentity`, which is itself anonymous and auditable. Governance's only power over the registry is over group membership, and while the group is empty no write can succeed.

## Why revocation is one registry

The credential circuit hides which approved issuer signed a credential and outputs the root it proved non-membership against. A verifier then asks a registry whether that root is current, so picking which registry to ask would name the issuer. `CredentialRevocationRegistry.isValidRoot(root)` takes the root alone.

The same holds off chain: with per-issuer registries, which tree a holder syncs leaks its issuer to whoever serves the snapshot.

The one thing to design around is write contention. Every mutation takes the predecessor index of the affected leaf, valid only against the tree state the transaction executes in, so two members revoking in the same block collide and one reverts. In order of preference: batch with `revokeMany`, have the issuer service send revocations one at a time, or recompute the index and resubmit. A resubmit reuses the same proof, since the message does not bind the index and a revert does not burn the nullifier.

The empty-tree root `0` gets the same grace window as any other superseded root. After the first revocation, it remains valid for `rootDuration` seconds (one hour by default), then expires. A zero-duration window rejects it immediately.

## The approved-member group

`NetworkMemberGate` is only the gate. It does not create the group, admit members or hold any membership state: it is pointed at an existing Semaphore group by id at construction, and stores it in `NETWORK_MEMBER_GROUP_ID`. `NetworkMemberGroup` creates that group on the Semaphore deployment and is its admin, and the governance Safe owns `NetworkMemberGroup`. Everything about the proof lifecycle is likewise Semaphore's:

- Governance maintains the set through `NetworkMemberGroup.addNetworkMember` and `removeNetworkMember`, which call Semaphore's `addMember` and `removeMember`.
- The recent-root window is the group's Merkle tree duration, one hour by default, so a proof built just before a membership change still lands. A removal therefore bites at `removal time + one hour`.
- `validateProof` records the proof's nullifier, so the same proof cannot be submitted twice. Clients pick a fresh random scope per proof, which makes each nullifier unlinkable from the last and leaves members unrate-limited.

What the gate adds is the binding, and it is structural rather than a check: the Semaphore message is never accepted from the caller. `NetworkMemberGate.NetworkMemberProof` is Semaphore's proof minus its message, and the `onlyNetworkMember(message, proof)` modifier fills that field in with the message the gated function derives from its own arguments. A proof repurposed for another payload therefore fails verification outright; there is no message field for an attacker to line up, and no comparison a future gated function could forget.

The message is `keccak256(UPDATE_DOMAIN_SEPARATOR, chainId, action, networkId, metaStealthAddress)`, where the separator is `keccak256(domain string, address(this))` hashed once at deployment. The payload is what stops a proof authorising a different update; the separator and the chain id place that update at one deployment. Both matter precisely because the registry does not own its group: two registries can be pointed at the same group id, and one registry can exist at the same address on two chains with the same members and therefore the same root, so without them a proof meant for one would authorise the other.
