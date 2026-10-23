# @coordination-network/network-member-proof

Generates the zero-knowledge proof that authorises an Identity Registry write as an approved network member.

The registry keeps no allowlist of member addresses. Authorisation is a Semaphore membership proof against the approved-member group, and every mutating function takes one: `registerIdentity`, `updateIdentity`, `removeIdentity`. What the chain learns is "an approved member made this change". It does not learn which one, and because no write path reads `msg.sender`, it learns nothing from the sending account either: submit from a fresh stealth address, with a paymaster paying, and the write is unlinkable to you.

**Scope.** This package does one thing: turn an identity, a group and an intended update into a proof the registry accepts. Creating a member identity, admitting members and mirroring the group from chain state are onboarding and governance concerns, handled separately. `generateSemaphoreProof` takes Semaphore's own `Identity` and `Group` as given.

## What the proof commits to

- **The message is the update itself.** `updateMessage()` hashes the action (register, update, remove), the `networkId`, the meta-stealth address, the registry address and the chain id. You do not submit it: the proof struct the registry takes has no message field, and the registry fills it in with the message it derives from the payload you passed. So a proof for "register A" submitted with the "register B" payload fails verification, and the registry address and chain id keep it from being usable at another deployment, including one sharing the same Semaphore group. `generateSemaphoreProof` handles the derivation; `updateMessage` is exported for anyone verifying a proof off chain, which does need it.
- **The scope is random, once per proof.** A Semaphore nullifier is `poseidon(secret, scope)`, so a fresh scope means a fresh nullifier: your updates do not link to each other, and there is no per-member rate limit. Semaphore still records every nullifier it has seen for the group, which is what makes resubmitting the same proof revert. Leave `scope` alone unless you have a reason not to; `randomScope()` is what the default uses.

## Usage

```ts
import { Group, Identity } from "@semaphore-protocol/core"
import { generateSemaphoreProof, UpdateAction } from "@coordination-network/network-member-proof"

const identity = Identity.import(process.env.MEMBER_IDENTITY!)

// The approved-member group as the registry's Semaphore group currently holds it, rebuilt from its
// on-chain membership events.
const group = new Group([123n, identity.commitment])

const proof = await generateSemaphoreProof({
    identity,
    group,
    registry: { chainId: 11155111n, address: "0x..." },
    update: {
        action: UpdateAction.Register,
        networkId: "0x...",
        metaStealthAddress: "0x..." // 66 bytes, ERC-6538 scheme 1
    }
})

// registerIdentity(networkId, metaStealthAddress, proof)
```

Submit it from wherever you like. The proof is the authorisation; the sender is not.

Two things to get right before submitting:

- **The group must match the chain.** A stale mirror produces a proof against an old root, which Semaphore accepts only inside the recent-root window below. Note that a removal leaves a zero leaf in place rather than compacting the tree, so a mirror has to replay the membership history rather than collect the current commitments.
- **The payload must match the proof.** Submit the exact `networkId` and meta-stealth address you passed to `generateSemaphoreProof`. Anything else reverts `Semaphore__InvalidProof`, because the registry will be verifying against the message for the payload you actually sent.

## The recent-root window

Membership changes move the group root, and a proof generated a moment earlier is against the old one. Semaphore accepts a superseded root for the group's Merkle tree duration, one hour by default, so in-flight proofs are not lost every time governance admits a member.

The cost is the mirror image: a removed member's already-generated proof stays usable until that root expires. Governance removing a member for cause should treat the removal as effective at `removal time + one hour`. After that the ex-member has no live root left to prove against and cannot build a proof against the current one, because their leaf is gone.

## Regenerating the Solidity fixtures

The contract tests verify real proofs, produced here and checked in at `packages/contracts/test/fixtures/network-member-proofs.json`. Regenerate them after any change to the message derivation:

```sh
yarn workspace @coordination-network/network-member-proof generate:fixtures
```

The fixtures pin the chain id and the registry address the proofs are bound to, and use fixed scopes so they are reproducible; the Solidity test base deploys the registry to that address.
