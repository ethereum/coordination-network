# After deploying

[`deploy-all.md`](../deployment/deploy-all.md) deploys the contracts, and this page configures them.
`yarn deployAndConfigureAll` runs all four steps below itself, **so skip this page if you have run `deployAndConfigureAll`**.

`DeployAll` creates the Safe with `OWNER` as its only owner and deploys every contract. Nothing is
usable until the owner runs the four scripts below, in order, with its own key. Each needs `.env`
values on top of the ones in [`1-before-deploy.md`](1-before-deploy.md). Copy the addresses from
`deployments/<chain id>.json` into `GOVERNANCE_SAFE`, `NETWORK_MEMBER_REGISTRY`,
`APPROVED_ISSUER_SET`, `NETWORK_MEMBER_GOVERNANCE` and `SEMAPHORE_PAYMASTER`. Each one's key in the
file is its name in camel case, so `GOVERNANCE_SAFE` is `governanceSafe`.

Run each with the owner's key, `--private-key "$OWNER_PRIVATE_KEY"` or `--account owner`:

```sh
forge script script/utils/ConfigureGovernance.s.sol --rpc-url sepolia --broadcast --private-key "$OWNER_PRIVATE_KEY"
forge script script/utils/FundPaymaster.s.sol --rpc-url sepolia --broadcast --private-key "$OWNER_PRIVATE_KEY"
forge script script/utils/AdmitNetworkMember.s.sol --rpc-url sepolia --broadcast --private-key "$OWNER_PRIVATE_KEY"
forge script script/utils/AddPaymasterMember.s.sol --rpc-url sepolia --broadcast --private-key "$OWNER_PRIVATE_KEY"
```

## 1. `ConfigureGovernance`

Sets the registry's `ApprovedIssuerSet` and enables `NetworkMemberGovernance` as a Safe module, as
two Safe transactions. The registry refuses every admission until the issuer set is set, and network members
after the first join through the module. A rerun skips whatever is already done.

Reads `GOVERNANCE_SAFE`, `OWNER`, `NETWORK_MEMBER_REGISTRY`, `APPROVED_ISSUER_SET` and
`NETWORK_MEMBER_GOVERNANCE`.

## 2. `FundPaymaster`

Deposits `PAYMASTER_DEPOSIT`, which the paymaster spends on gas, and stakes `PAYMASTER_STAKE` for
`PAYMASTER_UNSTAKE_DELAY` seconds. The deposit is needed for sponsoring transactions, whereas the stake is required for
bundler DOS protection. Each run adds more funds to both buckets, so don't run it twice by mistake.

Reads `SEMAPHORE_PAYMASTER`, `PAYMASTER_DEPOSIT`, `PAYMASTER_STAKE` and `PAYMASTER_UNSTAKE_DELAY`.

## 3. `AdmitNetworkMember`

Admits the founding network member. Set `NETWORK_MEMBER_MULTISIG_SIGNER` to `OWNER`: the founding
network member's governance signer already owns the Safe, so the script writes its registry record and group
leaf directly. A rerun skips both once they exist.

Reads `GOVERNANCE_SAFE`, `OWNER`, `NETWORK_MEMBER_GOVERNANCE`, `MEMBER_ACCOUNT_PUBLIC_KEY`,
`NETWORK_MEMBER_COMMITMENT` and `NETWORK_MEMBER_MULTISIG_SIGNER`.

`MEMBER_ACCOUNT_PUBLIC_KEY` and `NETWORK_MEMBER_COMMITMENT` are both derived from the network
member secret generator, `node script/generateNetworkMember.ts`. See
[Network member secret](1-before-deploy.md#network-member-secret).

## 4. `AddPaymasterMember`

Adds the founding network member's commitment to the paymaster's own Semaphore group, so the network member's server
can send sponsored transactions. The paymaster group is separate from the network member group, and
only its admin, the owner, can change it. A rerun does nothing.

Reads `SEMAPHORE_PAYMASTER` and `NETWORK_MEMBER_COMMITMENT`.

What comes after the first network member, such as admitting more network members or withdrawing the paymaster's
funds, is in [`3-operations.md`](3-operations.md).
