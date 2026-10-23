-- Nothing stored here can be matched against the chain. A `_hash` column holds a HMAC, which
-- can't be reversed, and is there so rows can be found by that value. An `encrypted_` column can
-- be decrypted with ENCRYPTION_KEY, and exists because the service needs that value back from
-- the DB. Some values get both, because we query by them and also return them back from DB.

-- one row per key the service scans for, with the `scanned_until_block` bookmark saying how far it's been checked
CREATE TABLE IF NOT EXISTS keys (
    spending_public_key_hash      TEXT PRIMARY KEY,
    -- encrypted: the plaintext would reveal which `accounts` belong to whom
    encrypted_spending_public_key TEXT NOT NULL,
    -- the entity the key belongs to, as registered onchain in identity registry
    network_id_hash               TEXT NOT NULL,
    encrypted_network_id          TEXT NOT NULL,
    encrypted_viewing_private_key TEXT NOT NULL,
    -- every block up to and including this one has been checked for this key
    scanned_until_block           BIGINT NOT NULL
);

-- one row per stealth address discovered onchain that belongs to one of our `keys`
CREATE TABLE IF NOT EXISTS accounts (
    id                             BIGSERIAL PRIMARY KEY,
    network_id_hash                TEXT NOT NULL,
    -- dedup key: re-processing a block is a no-op
    stealth_address_hash           TEXT NOT NULL UNIQUE,
    encrypted_stealth_address      TEXT NOT NULL,
    encrypted_ephemeral_public_key TEXT NOT NULL,
    -- `keys` row deletion cascades to `accounts` via the `spending_public_key_hash` reference
    spending_public_key_hash       TEXT NOT NULL REFERENCES keys ON DELETE CASCADE
);

-- lookup from network ID to that entity's `keys`, so deleting them does not read every row
CREATE INDEX IF NOT EXISTS keys_network_id_hash ON keys (network_id_hash);

-- lookup from network ID to that entity's `accounts`, so finding them does not read every row
CREATE INDEX IF NOT EXISTS accounts_network_id_hash ON accounts (network_id_hash);
