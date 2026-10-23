# Testing

How to run the contract tests in `packages/contracts/test`.

The Sepolia run of the whole system, with the testbed, is in [`e2e-runbook.md`](e2e-runbook.md).

## Run tests

```sh
yarn test
```

Use `yarn test` over `forge test`. Because the paymaster integration tests call Node through
`vm.ffi` to generate Semaphore proofs, and `foundry.toml` turns `ffi` off, only the explicit `--ffi` flag the yarn script adds allows them to run.

`yarn test` skips the fork tests. To run them, set `SEPOLIA_RPC_URL` and `MAINNET_RPC_URL`, then:

```sh
yarn test:fork
```

`yarn coverage` reports coverage for the unit tests and the deploy script integration test.

## Suites

- `test/unit/`
- `test/fuzz/`
- `test/integration/`
- `test/fork/`

## Proof fixtures

Some tests verify real Semaphore proofs against a real `Semaphore` deployment. The proofs are checked in at `test/fixtures/network-member-proofs.json` and `test/fixtures/credential-revocation-proofs.json`, regenerated with `yarn workspace @coordination-network/network-member-proof generate:fixtures` and `generate:revocation-fixtures`. Every proof binds the chain id and the contract address, so the tests pin that chain id and deploy to that address.

For the paymaster tests, `test/fixtures/semaphorePaymasterProofs.json` comes from
`node test/fixtures/generateSemaphorePaymasterFixtures.ts`.
