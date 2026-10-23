# Revocation in Coordination Network

Privacy-preserving revocation for verifiable credentials using zero-knowledge non-membership proofs.

This spec adapts the flow described in Privacy-Preserving Revocation for Verifiable Credentials Using Zero-Knowledge Non-Membership Proofs to the Coordination Network project. See that article for the full protocol, diagram, and design rationale. This document records only what is specific to our implementation.

## Goal

Let a verifier check that a presented credential has not been revoked, without learning which credential is being presented and without contacting the issuer. Revocation status is proven in zero-knowledge against an on-chain registry of revoked commitments.

## Entities

- **Network Member (issuer)**: issues credentials and revokes them by publishing commitments to the registry.
- **Registry On-Chain**: on-chain contract storing revoked commitments and publishing revocation roots.
- **User (Holder)**: generates the revocation secret on their device and produces zero-knowledge non-membership proofs at presentation time.
- **Verifier**: checks the proof and that its root is an accepted registry root.

## Phase 1 authorization

One shared registry stores revocation commitments for the whole network. Updates require an anonymous Semaphore proof from the approved network-member group, bound to the action and commitments. Any approved member can revoke any commitment, including one from another issuer. Phase 1 trusts approved members; the registry does not enforce issuer ownership.

Governance admission adds a member to that Semaphore group, giving it revocation rights. To issue credentials, the member must also publish its credential signing key to `ApprovedIssuerSet` through `POST /v1/membership/issuer-key`. Admission does not publish that key automatically. Complete both steps when onboarding an issuer.

Issuer-bound revocation is deferred unless it becomes a requirement.

## Flow Diagram

![Revocation flow diagram](assets/revocation-flow.png)

## Implementation decisions

### Revocation secret `r`

Each credential has its own revocation secret `r`: 32 random bytes generated on the holder's device at issuance and kept in the device's wrapped key storage. `r` never leaves the device. It is not sent to the issuer, not stored in the credential, and never revealed to a verifier. The issuance protocol has no field that could carry it.

`r` is always handled as raw bytes. Hex-encoding it before derivation yields a different commitment.

### Commitment

`r` is used directly as a Semaphore V4 identity private key. The revocation commitment is that identity's commitment:

```
commitment = SemaphoreIdentity(r).commitment
```

The identity's Baby Jubjub key pair is the credential's **revocation key**. Because `r` is high-entropy and unique per credential, each commitment is unique.

The commitment is tied to the credential because the issuer signs it into the credential body, not because it is derived from issuer or credential identifiers (see [VC Issuance and Verification](03-vc-issuance.md)). The commitment is the value published to the registry when the credential is revoked.

### Revocation tree

Revoked commitments are stored in a **LeanIMT+** tree. It is chosen for its low circuit complexity for non-membership proofs and its efficient tree operations both off-chain and on-chain. See LeanIMT+: Efficient Merkle Tree for Membership and Non-Membership Proofs.

### Registry

The registry is an **on-chain** contract. It is the source of truth for revoked commitments and revocation roots. The issuer revokes a credential by publishing its commitment to the registry, which updates the tree and its published root.

### Secret custody and trust model

The holder generates and keeps `r`. The issuer only ever receives the commitment, the revocation public key, and a signature proving ownership of that key. It records the commitment in its issuance record so it can revoke later, which only requires publishing the commitment.

No party other than the holder needs to be trusted with `r`. Specifically, the issuer cannot produce a non-revocation proof for a credential it issued, because that proof requires a signature from the revocation key.

## Credential schema requirements

To use this revocation solution:

- The credential body carries `revocationCommitment` as a decimal field element. It is one of the fields the issuer signs, so it cannot be changed without invalidating the credential.
- The holder stores `r` alongside the credential, in private device storage. `r` is sensitive and is not part of the credential body.

## Flow

**Issuance.** The holder's device generates `r`, derives the commitment, and sends the commitment to the issuer together with the revocation public key and an EdDSA signature over the issuer's challenge nonce. The issuer verifies the signature, recomputes the commitment from the public key, and checks that it matches. This proves the device owns the commitment, so a holder cannot embed someone else's commitment or a value that could never be revoked. The issuer then signs the commitment into the credential body and records it in its issuance record. Non-revoked credentials never appear in the registry tree.

**Revocation.** To revoke, the issuer publishes the credential's commitment to the on-chain registry. The registry inserts it into the LeanIMT+ tree and updates the published revocation root.

**Presentation.** The user produces a zero-knowledge proof that:

1. the revocation key signed the credential-bound session message, and its public key opens the `revocationCommitment` in the signed credential body,
2. that commitment is not present in the revoked-commitment tree (non-membership), and
3. the reconstructed revocation root, which the proof outputs.

The private witnesses are the revocation public key and its signature, plus the non-membership witness. `r` itself stays on the device and is used only to sign. See [VC Issuance and Verification](03-vc-issuance.md) for the full presentation circuit.

**Verification.** The verifier accepts the presentation if the ZK proof is valid and the output root is an accepted registry root.

### Root history

Verifiers check the proof's root with the registry's `isValidRoot`. It accepts the current root, and also an older root for a fixed time after a newer one replaced it (one hour by default), so that proofs generated shortly before a tree update do not fail unexpectedly. This mirrors Semaphore's root-history mechanism. The trade-off is that a newly revoked credential can still be presented against an older root until that root's window ends.

### Changing a revocation

Revocation is normally permanent. The registry also has two operations for correcting mistakes, such as a commitment revoked in error or an invalid value written to the tree:

- **`unrevoke(commitment)`** takes a commitment out of the registry. The credential becomes valid again as soon as the transaction is included.
- **`updateRevocationCommitment(old, new)`** replaces a revoked commitment with a different one in a single transaction: `old` becomes valid again and `new` becomes revoked.

Like a revocation, each operation needs an anonymous Semaphore proof of network membership, bound to that exact operation and its commitments. Because revocations are anonymous, a mistaken one cannot be traced to its author, so any approved member can correct it. This also means a member can undo another member's revocation, which the [Phase 1 threat model](threat-model-phase-1.md) accepts.

**What becomes public.** Like every registry write, both operations are visible to anyone reading the chain. `unrevoke` shows that a commitment is no longer revoked. `updateRevocationCommitment` shows the old and new commitments together, so an observer can tell one replaced the other. If two commitments should not appear related, use `unrevoke` and a separate `revoke` instead, spaced apart in time, since two writes landing back to back can be linked by their timing alone. Neither operation reveals `r` or affects the privacy of presentations.

**Effect on rebuilding the tree.** An `unrevoke` leaves an empty slot (a tombstone) where the commitment used to be. After that, the tree can no longer be rebuilt from the list of revoked commitments alone. Rebuilding needs the full list of slots, empty ones included.

## Privacy properties

The verifier never learns the credential secret, the commitment, or the credential's position in the tree. Successful presentations are anonymous and unlinkable, provided no other persistent identifier is disclosed during presentation. The issuer is not involved at presentation or verification time.

These properties hold unconditionally against verifiers, against anyone observing the public registry, and against the issuer, because the issuer never receives `r`. The issuer knows each credential's commitment, but a presentation never discloses it, so the issuer cannot link a presentation to an issuance record. The commitment becomes public only when the credential is revoked, or when one of the operations in [Changing a revocation](#changing-a-revocation) is applied to it.

## Implementation Optimizations

As the revoked-commitment set grows, two optimizations keep proving and syncing cheap.

- **Tree snapshots.** The data needed to build a non-membership witness is public, but reconstructing it from every revocation event since genesis is slow. Instead, publish periodic snapshots of the tree. A holder fetches the latest snapshot plus the few events since it, updates its local copy incrementally, and then computes its own witness (predecessor leaf and Merkle path) locally. This keeps syncing fast and is privacy-preserving: the holder only downloads commitment-independent public data and never tells anyone which commitment it cares about. The client must hash the fetched data up to the on-chain root and check it matches, so a snapshot is trusted only for availability, never for integrity.
- **Epoch-based revocation.** Instead of one ever-growing tree, split revocations into epochs, each a separate tree with its own published root. Because each epoch's tree only holds the revocations from that period and then closes, no single tree accumulates the full history, so trees stay far smaller than a single all-time tree and proving cost is bounded by per-period volume rather than all-time volume.

## Reference

- Protocol and flow:
    - [Revocation in zkID: Merkle Tree-based Approaches](https://pse.dev/blog/revocation-in-zkid-merkle-tree-based-approaches)
    - [Privacy-Preserving Revocation for Verifiable Credentials Using Zero-Knowledge Non-Membership Proofs](https://pse.dev/blog/privacy-preserving-revocation-for-verifiable-credentials-using-zero-knowledge-non-membership-proofs)
- [Semaphore V4 identities](https://docs.semaphore.pse.dev/guides/identities)
- [LeanIMT+](https://pse.dev/blog/lean-imt-plus-efficient-merkle-tree-for-membership-and-non-membership-proofs)
