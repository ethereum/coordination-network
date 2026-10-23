# coordination-network-contracts

The Foundry project for the coordination network's contracts. They publish as one npm package, [`@coordination-network/contracts`](src/README.md), which includes the [revocation registries](src/revocation/README.md).

Governance is documented in the [network member onboarding and governance runbook](docs/configuration/network-member-onboarding.md).

```shell
yarn build
yarn test
yarn fmt
yarn lint
```

`yarn test` skips the fork tests in `test/fork`, which need `SEPOLIA_RPC_URL` and `MAINNET_RPC_URL`. Run them before a deploy:

```shell
yarn test:fork
```

## Docs

Set up with `1-before-deploy.md` first, pick a deployment flow, and use the rest once the network runs.

### Deployment

- [`deploy-and-configure-all.md`](docs/deployment/deploy-and-configure-all.md): run a single command to deploy all contracts and configure them for production usage when you hold both the deployer key and the governance Safe owner key.
- [`deploy-all.md`](docs/deployment/deploy-all.md): deploy with only the deployer key, and the owner configures later.

### Configuration

- [`1-before-deploy.md`](docs/configuration/1-before-deploy.md): keys, `.env`, funding and the network member secret, for either flow.
- [`2-after-deploy.md`](docs/configuration/2-after-deploy.md): the four configuration scripts, run by hand
  after `deploy-all.md`.
- [`3-operations.md`](docs/configuration/3-operations.md): the paymaster's group and funds, and issuer
  keys, once the network runs.
- [`network-member-onboarding.md`](docs/configuration/network-member-onboarding.md): admitting,
  removing and exiting network members, and the governance rule.
- [`configuration-reference.md`](docs/configuration/configuration-reference.md): every important configuration value a
  production deployment decides, across the contracts, network member client, issuer service and indexer.

### Testing

- [`testing.md`](docs/testing/testing.md): running the contract tests and regenerating proof
  fixtures.
- [`e2e-runbook.md`](docs/testing/e2e-runbook.md): deploying to Sepolia and running the whole system
  end to end.

### Privacy

- [`privacy-disclosure.md`](docs/privacy-disclosure.md): what and how the network keeps private, and what it doesn't.

## How to use

### Deploy and configure separately

1. [`1-before-deploy.md`](docs/configuration/1-before-deploy.md)
2. [`deploy-all.md`](docs/deployment/deploy-all.md)
3. [`2-after-deploy.md`](docs/configuration/2-after-deploy.md)
4. [`3-operations.md`](docs/configuration/3-operations.md)
5. [`network-member-onboarding.md`](docs/configuration/network-member-onboarding.md), to admit more
   network members

### Deploy and configure together

1. [`1-before-deploy.md`](docs/configuration/1-before-deploy.md)
2. [`deploy-and-configure-all.md`](docs/deployment/deploy-and-configure-all.md)
3. [`3-operations.md`](docs/configuration/3-operations.md)
4. [`network-member-onboarding.md`](docs/configuration/network-member-onboarding.md), to admit more
   network members

### Run the end-to-end test

1. [`testing.md`](docs/testing/testing.md)
2. [`1-before-deploy.md`](docs/configuration/1-before-deploy.md), for the keys and the network member
   secret
3. [`e2e-runbook.md`](docs/testing/e2e-runbook.md)
