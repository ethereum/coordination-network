# Before deploying

What to set up before either deployment flow:
[`deploy-and-configure-all.md`](../deployment/deploy-and-configure-all.md) or
[`deploy-all.md`](../deployment/deploy-all.md).

Long-lived secrets stay out of `.env`. Private keys you keep after a deployment, like the owner's, should go in a
Foundry keystore. The founding network member's root secret goes in `network-member.env`.

## Deployment & owner keys

The scripts need two private keys for the same run. You can use `.env` directly, or Foundry keystores.

- **The deployer** sends every deployment. It's a fresh key made for deployment only.
- **The owner** is the governance Safe's initial owner and signer, and the paymaster's owner. This is the founding network member.

**Private keys in `.env`.** Set `DEPLOYER_PRIVATE_KEY` and `OWNER_PRIVATE_KEY`. Each deployment doc
outlines the flags that must be passed for them.

**Foundry keystore.** A keystore is a file holding a key encrypted with a password, so the key never
sits in `.env`. Run these once, from any directory:

```sh
cast wallet import deployer --interactive
cast wallet import owner --interactive
```

`--interactive` prompts you to paste an existing private key, and then asks you to choose a password. It saves the encrypted key to
`~/.foundry/keystores/deployer` or `~/.foundry/keystores/owner`. To make a new key, run
`cast wallet new`. The deploy commands name keystores with `--account`, and Foundry asks for each
password when it runs. `cast wallet address --account deployer` prints a keystore's address.

## Environment variables

Run `cp .env.example .env`. Then set the below variables, then run `source .env`:

- `SEPOLIA_RPC_URL` and `MAINNET_RPC_URL`
- `ETHERSCAN_API_KEY`
- `DEPLOYER` and `OWNER`, the two private keys' addresses

`.env.example` already holds defaults for `MAX_COST_PER_OP`, `PAYMASTER_DEPOSIT`, `PAYMASTER_STAKE`
and `PAYMASTER_UNSTAKE_DELAY`. [`configuration-reference.md`](configuration-reference.md#paymaster)
explains each value.

## Network member secret

The founding network member's identity is one secret, `MEMBER_IDENTITY_SECRET`. `deriveKeys` in
`packages/identity` and `new Identity(...)` derive its account key, network ID, meta-stealth address
and Semaphore commitment.

The network member secret generator, `node script/generateNetworkMember.ts`, creates
`network-member.env` holding only the secret, or reuses the file if it exists. It prints the network
member's account public key and commitment, never the secret. These values are printed so they can be piped into forge scripts without enabling ffi on scripts.

### With `deployAndConfigureAll`

`yarn deployAndConfigureAll:sepolia` and `:mainnet` run the network member secret generator, and `env`
passes the two printed values to the Solidity deploy scripts. A rerun reuses the file and admits the
same network member. If the file changes between runs, the deploy stops with
`DifferentFoundingMemberAdmitted` rather than admit a second founding network member.

### With `deployAll`

Run the network member secret generator yourself and paste `MEMBER_ACCOUNT_PUBLIC_KEY` and
`NETWORK_MEMBER_COMMITMENT` into `.env`:

```sh
node script/generateNetworkMember.ts
```

[`2-after-deploy.md`](2-after-deploy.md) uses both values.

### After either deployment

`network-member.env` is the only copy of the founding network member secret until the network member backend has it. Keep the file until then. Once the deploy has succeeded:

1. Load `network-member.env` into the network member backend's secret store, which gives the backend
   `MEMBER_IDENTITY_SECRET` as an environment variable. With Kubernetes, for example:
   `kubectl create secret generic network-member --from-env-file=network-member.env`. You can also copy and paste it manually.
2. Keep an offline backup. A lost secret is a lost network member identity.
3. Delete the local copy.

## Fund the deployer and owner keys

On Sepolia, the deployer needs about 0.1 test ETH and the owner at least 1.2: 1 for the stake, 0.1
for the deposit, the rest for gas.

For mainnet, you can calculate the deployer key funding amount from the Sepolia run gas values located in `deployments/11155111.json`, under `gas`, added up and multiplied by the
mainnet gas price. Those values leave out each transaction's base cost, so add about 10%. The owner needs `PAYMASTER_DEPOSIT` plus `PAYMASTER_STAKE`, and about 0.05 ETH for gas.

On mainnet, set `PAYMASTER_STAKE` to what your bundler requires. The chosen bundler enforces the stake offchain, not the EntryPoint. Self-hosting Alto with `min-entity-stake` set to a
token amount such as 0.001 ETH keeps it near zero. A hosted bundler such as Alchemy's Rundler asks for
0.1 ETH. [Paymaster configuration reference](configuration-reference.md#paymaster) explains this further.
