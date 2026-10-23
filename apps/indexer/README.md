# @coordination-network/indexer

The service polls the chain, fetches ERC-5564 `Announcement` events from the
announcer contract, and checks each one against the saved keys. Discovered
accounts and per-key scan progress persist in Postgres, so restarts resume
where they stopped.

## Run

```sh
cd apps/indexer
cp .env.example .env
# set AUTH_TOKEN and MASTER_KEY, each to a fresh echo "0x$(openssl rand -hex 32)"
docker compose up -d
yarn start
```

The service starts with no keys and discovers nothing until the network
member's backend registers some over `POST /keys`.

`docker compose up` runs a local Postgres. In production, point `DATABASE_URL`
at a managed Postgres instead, and take `AUTH_TOKEN`, `ENCRYPTION_KEY` and
`LOOKUP_HASH_KEY` from a secrets vault rather than a file. `DEPLOYMENT.md` covers the rest of a
production deployment needs.

The database stores nothing that can be matched against the chain. Network IDs, spending
keys and stealth addresses are looked up by an HMAC under `LOOKUP_HASH_KEY`. An HMAC is a hash
computed with a secret key, so the same input always gives the same output, but only someone
holding the key can compute or check it. A plain hash wouldn't work because network IDs are public, so anyone
could hash them all and match the results. Everything the service needs to return from the DB is encrypted under
`ENCRYPTION_KEY`. A leaked database shows how many users there are and how many
accounts each has, not who they are or which accounts.

| Env variable                 | Meaning                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                       | HTTP port                                                                                                                                                            |
| `TRUSTED_PROXY_ADDRESS`      | The TLS proxy's address or subnet. Only connections from it may set the logged client address through `X-Forwarded-For`                                              |
| `RPC_URL`                    | Chain RPC endpoint                                                                                                                                                   |
| `ANNOUNCER_ADDRESS`          | ERC-5564 announcer contract                                                                                                                                          |
| `TOKEN_ADDRESS`              | The network member's ERC-1155 scoped token contract                                                                                                                  |
| `START_BLOCK`                | Placeholder `lowestScannedBlock` on `/health` before any key is registered                                                                                           |
| `SCAN_INTERVAL_MS`           | Polling interval                                                                                                                                                     |
| `AUTH_TOKEN`                 | Shared bearer token the network member's backend authenticates with                                                                                                  |
| `ENCRYPTION_KEY`             | 32 bytes of hex the stored values are encrypted with                                                                                                                 |
| `LOOKUP_HASH_KEY`            | 32 bytes of hex the lookup columns are hashed with                                                                                                                   |
| `DATABASE_URL`               | Postgres connection string                                                                                                                                           |
| `MAX_BLOCK_SCAN_WINDOW_SIZE` | Largest `eth_getLogs` block range, shrunk automatically when the RPC rejects it                                                                                      |
| `CONFIRMATIONS`              | Confirmations required before scanning succeeds, so reorgs can't orphan scanned announcements. Finality takes around 12 minutes, but reorgs are rare beyond 2 blocks |
| `LOG_LEVEL`                  | `trace`, `debug` or `info`.                                                                                                                                          |
| `LOG_FORMAT`                 | `json` when deployed, `pretty` for a readable local console                                                                                                          |

## API

Every route needs `Authorization: Bearer $AUTH_TOKEN`, `/health` included, so a
load balancer or container probe has to send the token too. The API is
internal: the network member's own backend is the only caller, and it may query
for all of its own users and delegated users.

`POST /keys` — registers one entity's keys as
`{ "networkId": "0x...", "spendingPublicKey": "0x...", "viewingPrivateKey": "0x...", "fromBlock": <block> }`.
`fromBlock` is the first block to scan for that key: the current chain head for
a freshly generated key, or the block it was already in use from if handed over
later, so its old announcements get scanned too. The scan loop picks the key up
on its next pass, so a new entity needs no restart. A new key answers `201`. A
key already registered keeps the scan progress it has made and answers `409`,
so a caller can tell its `fromBlock` did not take effect.

`GET /accounts?networkId=0x...&limit=100&after=<id>` — one page of discovered
stealth accounts in discovery order, as
`{ "accounts": [{ "stealthAddress": "0x...", "ephemeralPublicKey": "0x..." }], "nextCursor": "142" | null }`.
Pass `nextCursor` as `after` to fetch the next page. `ephemeralPublicKey` is what a wallet needs alongside the keys to spend the account.

`GET /balances?networkId=0x...&tokenIds=0&tokenIds=1&limit=100&after=<id>` — the same
page of accounts with what each holds, one entry per account and token id, as
`{ "balances": [{ "stealthAddress": "0x...", "tokenId": "0", "balance": "50" }], "nextCursor": "142" | null }`.
`tokenIds` is required and repeated once per token id, up to 50: the member
issues one token id per scope (category, currency, validity, programme),
so the caller lists the ones it wants. That is how the till shows a delegated
user a balance per token id in one request. Balances are read from the chain on
request, since a transfer moves them without any announcement to scan.

`GET /health` — scan progress: `{ latestBlock, lowestScannedBlock, lagBlocks, lastScanAt, lastError }`.
A growing `lagBlocks` or a persistent `lastError` means the scan is stuck, not
that there are no deliveries.

`DELETE /keys/0x...` — deletes an entity's keys and every account found with
them, for when its identity is removed onchain. Returns `404` when no corresponding `networkId` to delete is found. Returns `204` when the resource was deleted successfully. To correct a key registered with the wrong details, delete it and register it again.

## Test

```sh
yarn test:indexer              # no dependencies
yarn test:indexer:integration  # needs foundry and docker
```
