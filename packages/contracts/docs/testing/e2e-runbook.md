# Deploying the coordination network to a test network and running e2e test

To deploy without the end-to-end test, on Sepolia or mainnet, use
[`deploy-and-configure-all.md`](../deployment/deploy-and-configure-all.md).

Start with `cp .env.example .env`, which fills in every value that doesn't change between deployments, then set
`SEPOLIA_RPC_URL`, `SEPOLIA_BUNDLER_URL`, `ETHERSCAN_API_KEY` and the following two key-address pairs:

- `DEPLOYER_PRIVATE_KEY`, and `DEPLOYER` for its address (`cast wallet address --private-key
"$DEPLOYER_PRIVATE_KEY"`). It needs about 0.1 ETH for gas.
- `OWNER_PRIVATE_KEY`, and `OWNER` for its address. It needs at least 1.2 test ETH: 1 for the stake,
  0.1 for the deposit, the rest for gas.

Each step below names what to add to `.env`. Run `source .env` once before.

## The command list in order

```sh
source .env
yarn test:fork # rehearse against a fork
yarn deployAndConfigureAll:sepolia --private-keys "$DEPLOYER_PRIVATE_KEY" --private-keys "$OWNER_PRIVATE_KEY" --sender "$DEPLOYER"
forge script script/test/DeployTestScopedToken.s.sol --rpc-url sepolia --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
source network-member.env
export RPC_URL="$SEPOLIA_RPC_URL" BUNDLER_URL="$SEPOLIA_BUNDLER_URL" OWNER_PRIVATE_KEY MEMBER_IDENTITY_SECRET TEST_SCOPED_TOKEN=<address DeployTestScopedToken printed>
(cd ../.. && yarn workspace integration-testbed test:testnet)
set -a; . ../../.stack.env; set +a    # step 5
(cd ../.. && yarn stack:genesis)      # sets up once, rerun to refill
(cd ../.. && yarn stack:testnet)      # the demo stack, for the phones
forge script script/utils/WithdrawPaymasterDeposit.s.sol --rpc-url sepolia --broadcast --private-key "$OWNER_PRIVATE_KEY"

# wait a day, then
forge script script/utils/WithdrawPaymasterStake.s.sol --rpc-url sepolia --broadcast --private-key "$OWNER_PRIVATE_KEY"
```

`--rpc-url sepolia` reads `SEPOLIA_RPC_URL` from `foundry.toml`.

## 1. Rehearse against a copy of the network

**Set Environment**

- `SEPOLIA_RPC_URL` and `MAINNET_RPC_URL`. Both are required.

**Command**

```sh
yarn test:fork
```

Runs the whole deployment against Sepolia and mainnet forks, over the real
Semaphore, EntryPoint and Safe contracts. Nothing is sent and
nothing is spent. If it fails, stop the e2e test and fix any bugs.

## 2. Deploy and configure the network with `deployAndConfigureAll`

**Set Environment** nothing new. The full deployment and configure run generates `network-member.env` under the hood holding the founding
member's secret, and admits that member. A rerun reuses the file. The testbed runs as this network
member in [the end-to-end test](#4-run-the-end-to-end-test). [Network member secret](../configuration/1-before-deploy.md#network-member-secret) outlines what to do with the file after deployment.

**Command**

```sh
yarn deployAndConfigureAll:sepolia --private-keys "$DEPLOYER_PRIVATE_KEY" --private-keys "$OWNER_PRIVATE_KEY" --sender "$DEPLOYER"
```

The yarn script runs the network member secret generator, `script/generateNetworkMember.ts`, which prints the network member's account
public key and commitment. It then runs `forge script script/DeployAndConfigureAll.s.sol --rpc-url sepolia --broadcast --verify --verifier etherscan`, with the key and commitment set as environment
variables and the key flags above added to the end of the command. `--private-keys` gives Foundry the deployer and owner keys, and `--sender` says the deployer sends the deployments. The owner's key sends the rest.

[`deploy-and-configure-all.md`](../deployment/deploy-and-configure-all.md) lists the six scripts it
runs and the deployment file it writes.

## 3. Deploy the test token with `DeployTestScopedToken`

**Set Environment** nothing new.

**Command**

```sh
forge script script/test/DeployTestScopedToken.s.sol --rpc-url sepolia --broadcast --private-key "$DEPLOYER_PRIVATE_KEY"
```

Deploys the stand-in token the end-to-end run moves between accounts.

## 4. Run the end-to-end test

**Set Environment**

Run these in the same terminal as the earlier steps, still in `packages/contracts`, after [deploying the test token](#3-deploy-the-test-token-with-deploytestscopedtoken).
The testbed doesn't read `.env`, so `export` passes it what it needs from the values `source .env`
already loaded. `MEMBER_IDENTITY_SECRET` lets the testbed revoke as the founding network member
[`deployAndConfigureAll`](#2-deploy-and-configure-the-network-with-deployandconfigureall) admitted.
`TEST_SCOPED_TOKEN` is the address
[`DeployTestScopedToken`](#3-deploy-the-test-token-with-deploytestscopedtoken) printed.

```sh
source network-member.env
export MEMBER_IDENTITY_SECRET
export RPC_URL="$SEPOLIA_RPC_URL"
export BUNDLER_URL="$SEPOLIA_BUNDLER_URL"
export OWNER_PRIVATE_KEY
export TEST_SCOPED_TOKEN=<address DeployTestScopedToken printed>
```

**Command**

```sh
cd ../..
yarn workspace integration-testbed test:testnet
```

Issues a credential, presents it, verifies it, revokes it, then delivers tokens to a stealth address
and transfers them with the paymaster paying. It reads addresses from the deployment file and
deploys nothing.

## 5. Run the stack and the phones against this deployment

The deployment file also lets the demo stack, and so the phone apps, run on this network. Do this before
step 6, since genesis funds the paymaster's deposit and step 6 takes it back. Follow the "Testnet mode"
section of [`apps/integration-testbed`](../../../apps/integration-testbed/README.md#testnet-mode): it
sets up Member A and Member B with `yarn stack:genesis`, then serves the network with `yarn stack:testnet`.
Genesis needs about 0.50 ETH more on `OWNER` than step 1 spent, and is rerun to refill, never while the
stack serves. A relative `DEPLOYMENT_FILE` is from the repository root.

**Set Environment**

Put the stack's settings in an untracked file, `.stack.env` at the repository root, and load it. Do not
type them on the command line: your shell history would keep them.

```sh
RPC_URL=<your Sepolia RPC URL>
OWNER_PRIVATE_KEY=<the owner key from the top of this runbook>
STACK_BUNDLER_PRIVATE_KEY=<a new key; it pays the bundler's gas and nothing else>
STACK_MEMBER_SEEDS=<three distinct comma-separated 32-byte hex seeds, never the founding member's secret>
DEPLOYMENT_FILE=<path to the deployment file from step 2, if it is not the one named for the chain id>
```

**Command**, from the repository root

```sh
set -a; . ./.stack.env; set +a
yarn stack:genesis   # sets the network up once; rerun to refill
yarn stack:testnet
```

The Safe starts with `OWNER` as its only owner. Genesis admits Member A and Member B through it, so afterwards
its owners are `OWNER`, Member A and Member B, at threshold 2, and the candidate's admission takes Member A
and Member B. Keep
`.stack.env` private and backed up: the seeds are the stack's keys for good.

## 6. Take the money back

**Set Environment**

- `SEMAPHORE_PAYMASTER`, from the deployment file
- `PAYMASTER_WITHDRAW_TO`, where the ETH should go

**Command**

```sh
cd packages/contracts
forge script script/utils/WithdrawPaymasterDeposit.s.sol --rpc-url sepolia --broadcast --private-key "$OWNER_PRIVATE_KEY"
# wait 24 hours, then
forge script script/utils/WithdrawPaymasterStake.s.sol --rpc-url sepolia --broadcast --private-key "$OWNER_PRIVATE_KEY"
```

Both need the owner's key, and the stake can't come back until 24 hours after the deposit is withdrawn. See
[Paymaster funds](../configuration/3-operations.md#paymaster-funds).

## Troubleshooting

- **A script says a contract is already deployed.** Normal. `DeployAndConfigureAll` and
  `DeployTestScopedToken` check what already exists first, so rerunning them after a failure is safe.
  `DeployAndConfigureAll` also skips funding once the paymaster has a stake.
- **`DeployerIsOwner`.** `DEPLOYER` and `OWNER` are the same address. Nothing was sent.
- **`SenderIsNotTheDeployer`.** `--sender` isn't `DEPLOYER`. Nothing was sent.
- **`DifferentFoundingMemberAdmitted`.** `network-member.env` was deleted or replaced after an earlier
  run admitted the founding network member, so the script stops rather than admit the new secret as
  a second founding network member. Restore the original file, or start a [fresh deployment](../deployment/deploy-and-configure-all.md#fresh-deployment).
- **The end-to-end run cannot find an address.** The deployment file is named for the chain id it
  connected to. Check `RPC_URL`.
- **The bundler rejects the sponsored transaction.** Usually the stake or its delay is below what
  that bundler wants. Raise `PAYMASTER_STAKE` and run `script/utils/FundPaymaster.s.sol`, which adds
  to the existing stake.
- **The run stops on "the revocation tree holds commitments this run does not know about".** A
  previous run already revoked against this deployment. The run only works against a fresh tree, so
  start a [fresh deployment](../deployment/deploy-and-configure-all.md#fresh-deployment).
