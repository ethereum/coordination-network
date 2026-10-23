# Deploy and configure in one command

`yarn deployAndConfigureAll` deploys every contract and configures the network in one run, on Sepolia
or mainnet. To deploy now and configure later, use [`deploy-all.md`](deploy-all.md).
[`e2e-runbook.md`](../testing/e2e-runbook.md) covers the end-to-end run on Sepolia.

Two keys are required: the deployer key and the Safe owner key.

- **The deployer** sends every deployment. It's a fresh key made for deployment only.
- **The owner** is the governance Safe's initial owner and signer, and the paymaster's owner.

## Before you start

Set up the keys, `.env` and funding as [`1-before-deploy.md`](../configuration/1-before-deploy.md)
describes. The run creates `network-member.env` for the founding network member.

## Deploy

```sh
# test deployment scripts against forks
yarn test:fork
```

```sh
# Sepolia, with private keys in .env
yarn deployAndConfigureAll:sepolia --private-keys "$DEPLOYER_PRIVATE_KEY" --private-keys "$OWNER_PRIVATE_KEY" --sender "$DEPLOYER"

# Mainnet, with Foundry keystores
yarn deployAndConfigureAll:mainnet --account deployer --account owner --sender "$DEPLOYER"
```

The first command rehearses the whole deployment against copies of Sepolia and mainnet.

The second deploys every contract, configures governance, funds the paymaster and admits the
founding network member from `network-member.env`. The yarn script adds `--rpc-url`, `--broadcast`,
`--verify` and `--verifier etherscan`. `--sender` says the deployer sends the deployments, and
the owner's key sends the rest.

It runs these in turn:

1. `script/generateNetworkMember.ts`, the network member secret generator, creates or reuses
   `network-member.env` and prints the founding network member's account public key and commitment.
2. `script/DeployAll.s.sol`, as the deployer, creates the governance Safe with the owner as its only
   owner and deploys all eight contracts. [`deploy-all.md`](deploy-all.md) lists the nine deploy
   scripts it calls.
3. `script/utils/ConfigureGovernance.s.sol`, as the owner, wires the issuer set into the registry and
   enables the governance module on the Safe, so network members can be admitted.
4. `script/utils/FundPaymaster.s.sol`, as the owner, funds the paymaster, which pays gas for people
   holding no ETH. The deposit is spent, the stake is locked and returned. Bundlers refuse a paymaster
   whose stake unlocks too quickly, so the delay is a day, which is also why the stake takes a day to
   come back while the deposit returns immediately.
5. `script/utils/AdmitNetworkMember.s.sol`, as the owner, admits the founding network member with the
   owner as its governance signer.
6. `script/utils/AddPaymasterMember.s.sol`, as the owner, adds the founding network member to the
   paymaster's group, so the paymaster sponsors its transactions.

[`2-after-deploy.md`](../configuration/2-after-deploy.md) describes each configuration script and the
`.env` values it reads.

It writes `deployments/<chain id>.json` with every address, the block, and each contract's gas.
Commit that file and `broadcast/`: they record what was deployed and what it cost. A gas reading of zero
means the contract already existed, so keep the first run's file after a retry.

A rerun is safe. Every step skips work that's already done, and funding is skipped once the paymaster
has a stake.

## Fresh deployment

Every contract deploys to a fixed CREATE2 address, so rerunning the same scripts finds the existing
deployment and changes nothing. To deploy a new network instead:

1. Bump the version on every salt, `V1` to `V2`. That's `SALT_NONCE` in `script/DeploySafe.s.sol`
   and `SALT` in the other eight `script/Deploy*.s.sol` files:

    ```diff
    - bytes32 public constant SALT = keccak256("coordination-network.NetworkMemberRegistry.V1");
    + bytes32 public constant SALT = keccak256("coordination-network.NetworkMemberRegistry.V2");
    ```

2. Keep `network-member.env` to admit the same founding network member into the new network, or move
   it aside so the network member secret generator makes a new one.
3. Withdraw the old paymaster's deposit and stake, as
   [Paymaster funds](../configuration/3-operations.md#paymaster-funds) describes.

Then run the deploy command again.

## Troubleshooting

- **`deployments/<chain id>.json` shows zero gas after a rerun.** A rerun records zero for every
  contract that already existed.
- **`DeployerIsOwner`.** `DEPLOYER` and `OWNER` are the same address. Nothing was sent.
- **`SenderIsNotTheDeployer`.** `--sender` isn't `DEPLOYER`. Nothing was sent.
- **`DifferentFoundingMemberAdmitted`.** `network-member.env` was deleted or replaced after an earlier
  run admitted the founding network member, so the script stops rather than admit the new secret as
  a second founding network member. Restore the original file, or start a [fresh deployment](#fresh-deployment).
