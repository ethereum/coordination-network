# Deploy all, then configure separately

`DeployAll` deploys the governance Safe and every contract without configuring anything. The owner
then configures the deployment in a separate step, with
[`2-after-deploy.md`](../configuration/2-after-deploy.md). To do both in one command, use
[`deploy-and-configure-all.md`](deploy-and-configure-all.md) instead.

`script/DeployAll.s.sol` calls these deploy scripts in turn:

1. `DeploySafe.s.sol`
2. `DeployNetworkMemberRegistry.s.sol`
3. `DeployNetworkMemberGroup.s.sol`
4. `DeployNetworkMemberGovernance.s.sol`
5. `DeployApprovedIssuerSet.s.sol`
6. `DeployIdentityRegistry.s.sol`
7. `DeploySemaphorePaymaster.s.sol`
8. `DeployRevocation.s.sol`
9. `DeployCredentialRevocationRegistry.s.sol`

## When to use it

If the governance Safe owner's key isn't available, set `OWNER` to an address and deploy without
configuring. Only the deployer's key is needed for `deployAll`, and only the deployer needs funding.

## Before you start

Set up `.env` and the deployer key as outlined in [`1-before-deploy.md`](../configuration/1-before-deploy.md).
`DeployAll` reads `DEPLOYER`, `OWNER` and `MAX_COST_PER_OP`, and reverts if
`DEPLOYER` and `OWNER` are the same address.

## Deploy

```sh
# test deployment scripts against forks
yarn test:fork
```

```sh
# Sepolia, with the private key in .env
yarn deploy:sepolia --private-key "$DEPLOYER_PRIVATE_KEY"

# Mainnet, with a Foundry keystore
yarn deploy:mainnet --account deployer
```

The yarn deploy script runs `forge script script/DeployAll.s.sol` with `--broadcast --verify --verifier
etherscan` and the network's `--rpc-url`. It creates the Safe with `OWNER` as its only owner and
deploys the network member registry, the network member Semaphore group, the governance module, the
issuer set, the identity registry, the paymaster and both revocation contracts. It writes every
address to `deployments/<chain id>.json`.

It takes one private key for the deployer and no `--sender`, unlike the deploy and configure command. The deploy and configure command deployment also holds the
owner's key for the configuration steps. So `--sender` has to say which key sends the deployments.

A rerun skips every contract that already exists, since each one deploys to a fixed address.

## Next steps

The contract deployment is not ready for production yet. Continue with [`2-after-deploy.md`](../configuration/2-after-deploy.md), which
takes the addresses from the deployment file and runs the four configuration scripts with the owner's
key.

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

Then run the deploy command again, and configure the new network with
[`2-after-deploy.md`](../configuration/2-after-deploy.md).
