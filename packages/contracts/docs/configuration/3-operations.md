# Operations

This document covers what to do once the network is running, including:

- Admitting network members
- Keeping the paymaster's group and funds
  in order
- Managing issuer keys.

Each section names the Solidity functions to call and who may call them.

## Network members

Admission, removal and voluntary exit go through governance, as
[`network-member-onboarding.md`](network-member-onboarding.md) describes. Each one changes the
network member group, and the paymaster group needs the same change made manually.

## Paymaster group

`SemaphorePaymaster` sponsors only commitments in its own Semaphore group, which is separate from the
network member Semaphore group. Nothing currently keeps them in step. The paymaster's owner, the group's admin, makes
each change itself:

- After governance admits a network member onchain into the `NetworkMemberRegistry`, through the Safe's `admitMember` transaction:
  `addMember(GROUP_ID, commitment)`, with the network member's
  `NETWORK_MEMBER_COMMITMENT`. `script/utils/AddPaymasterMember.s.sol` does this and skips a
  commitment that's already there.
- After a removal or an exit: `removeMember(GROUP_ID, commitment, merkleProofSiblings)`. **Until then, the removed network member's transactions are still sponsored**.

The same group also holds users' sponsorship commitments. Those are derived separately from their
credential keys, as [spec 05](../../../../specs/05-stealth-addresses.md) describes.

## Paymaster funds

- **Top up the deposit:** `deposit()`, payable. Anyone can call it, and
  `script/utils/FundPaymaster.s.sol` calls it with `PAYMASTER_DEPOSIT`.
- **Add stake:** `addStake(unstakeDelaySec)`, payable, owner only. `FundPaymaster` calls it too, so
  that script adds to both.
- **Withdraw:** `withdrawTo(to, amount)` and `unlockStake()`, then `withdrawStake(to)` once the delay
  has passed. All three are owner only. `script/utils/WithdrawPaymasterDeposit.s.sol` runs the first
  two and `script/utils/WithdrawPaymasterStake.s.sol` the third, both sending to
  `PAYMASTER_WITHDRAW_TO`.

Only the paymaster's owner can withdraw, so both run with the owner's key.
The deposit returns at once and starts the clock on the stake. The stake follows a day later, and
withdrawing it early fails.

## Issuer keys

`ApprovedIssuerSet` holds every network member's credential signing keys, up to eight live keys each. A
network member's auth address or governance calls:

- `publishIssuerKey(memberNetworkId, publicKeyX, publicKeyY)` or `publishIssuerKeys` for several.
  Publishing a new key doesn't retire the old one.
- `retireIssuerKey(memberNetworkId, leaf)` for routine rotation. Proofs built against older roots
  keep verifying for `rootDuration`, one hour by default.
- `retireIssuerKeyImmediately(memberNetworkId, leaf)` can be utilised when a key is stolen. It also rejects every
  older root at once, so proofs in flight have to be rebuilt.

Removing a network member retires all its keys in the same transaction, through `retireAllIssuerKeys`, which
only the registry can call. Governance changes the grace window with `updateRootDuration`. A shorter
window limits how long a retired key keeps working, and a longer one fails fewer proofs in flight, as the
[issuer keys config reference](configuration-reference.md#issuer-keys)
explains.

## Extra revocation registries

`script/utils/CreateRevocationRegistry.s.sol` creates a registry on the `Revocation` deployment with
`REVOCATION_ADMIN` as its admin. The network never needs it, because `CredentialRevocationRegistry`
creates the network's one registry at deployment and every issuer shares it, so the script is only for
someone else building on the same `Revocation` deployment.
