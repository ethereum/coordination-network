# Deploying the indexer

## Run

We can run a development and production deployment. They should not be reachable from internet, each has distinct databases and secrets.

1. Put the service on a private network. The network member's backend is its only caller.
2. Put a TLS 1.2+ terminating proxy in front of it. The service itself handles no TLS.
3. Configure that proxy to set `X-Forwarded-For`, and to overwrite any the caller sent. Set `TRUSTED_PROXY_ADDRESS` to the proxy's address or subnet, such as `10.0.0.0/16`. The service reads the client address it logs from that header.
4. Create a managed Postgres per environment, privately reachable, with TLS good enough for `sslmode=verify-full`. Add the provider's CA bundle as `sslrootcert` if it's refused.
5. Point a log collector at the container's stdout.
6. Secrets manager requires the 5 values below. A deployment set up from an older `.env.example` must rotate `AUTH_TOKEN`, `ENCRYPTION_KEY` and `LOOKUP_HASH_KEY`, since the values it shipped are public. After rotating `ENCRYPTION_KEY`, the member's backend must register its viewing keys again over `POST /keys`.
    - `AUTH_TOKEN` is the bearer token the member's backend authenticates with.
    - `ENCRYPTION_KEY` is 32 hex bytes encrypting the stored values. Use a different one per environment. Losing it leaves every stored key as undecryptable.
    - `LOOKUP_HASH_KEY` is 32 hex bytes hashing the columns rows are looked up by. Use a different one per environment. Losing it makes every stored row unfindable.
    - `DATABASE_URL` holds the database password.
    - `RPC_URL` holds the provider's API key. The RPC provider is trusted. For example, it can see every `/balances` call, which lists user accounts.
7. Set the rest as plain configuration: `PORT`, `ANNOUNCER_ADDRESS`, `TOKEN_ADDRESS`, `START_BLOCK`, `SCAN_INTERVAL_MS`, `MAX_BLOCK_SCAN_WINDOW_SIZE`, `CONFIRMATIONS`, `LOG_FORMAT=json` and `LOG_LEVEL=info`. Nothing above `info` is accepted, because the access log is written at `info`.
8. Build and deploy:

```sh
docker build -f apps/indexer/Dockerfile -t coordination-network-indexer .
```

On boot it applies the database schema. It starts with no keys and discovers nothing until the member's backend registers some over `POST /keys`.

## Monitor

`GET /health` returns `{ latestBlock, lowestScannedBlock, lagBlocks, lastScanAt, lastError }`, and needs `AUTH_TOKEN` like every other route. Alert on `lagBlocks` climbing and on `lastError` staying non-null. A stalled scan keeps answering requests, returning empty results.

Access log entries carry `kind: "access"`. Each one records which user was looked up and when. Consider setting reasonable retention policies, for example, set the log store to delete entries after 30 days.

Logs carry `RPC_URL`, which holds a live provider API key, so the log store holds a credential.

## Troubleshooting

- Schema changes in production must be migrated directly. A local database created before 9th October 2026 has the old schema, so the service fails at start up. You can do either of the following:
    - Drop only the tables. Postgres must be removed: `source .env`, then `psql "$DATABASE_URL" -c "DROP TABLE accounts, keys"`.
    - Delete the whole DB. Its container must not be running (`docker compose down`), then `docker volume rm indexer_postgres-data`.
