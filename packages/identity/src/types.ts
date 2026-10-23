/** A `0x`-prefixed lowercase hexadecimal string. */
export type Hex = `0x${string}`

/** An Ethereum address. */
export type Address = Hex

/** A secp256k1 keypair, all fields normalized lowercase hex. */
export interface Secp256k1Keypair {
    /** 32-byte scalar, `0x` + 64 hex chars, lowercase. */
    privateKey: Hex
    /** 33-byte compressed SEC1 public key. */
    publicKey: Hex
    /** 65-byte SEC1 public key, `0x04`-prefixed (uncompressed form). */
    uncompressedPublicKey: Hex
}

/** The full key set derived from one device secret, plus the device's `networkId` and `memberNetworkId`. */
export interface DerivedKeys {
    /** Derivation scheme version. See {@link KEY_DERIVATION_VERSION}. */
    version: "v2"
    /** bytes32 user identifier: `keccak256(utf8(DOMAIN_NETWORK_ID) || X || Y)` of the account pubkey. */
    networkId: Hex
    /** bytes32 member identifier: `keccak256(X || Y)`; its low 20 bytes are the member's auth address. */
    memberNetworkId: Hex
    /** Root secp256k1 keypair the other keys are derived from. */
    account: Secp256k1Keypair
    /** secp256k1 keypair used to authorize spending. */
    spending: Secp256k1Keypair
    /** secp256k1 keypair used to derive/scan stealth viewing tags. */
    viewing: Secp256k1Keypair
    /** secp256k1 keypair used to authenticate as the device. */
    auth: Secp256k1Keypair
}

/**
 * The Baby Jubjub EdDSA keypair and Semaphore-v4 identity commitment (the
 * "fifth key") — a stable device-level ZK-identity key, rooted in a hardware
 * ECDH shared secret rather than the device secret. See `DERIVATION.md` §12.
 */
export interface EddsaKeypair {
    /**
     * 32-byte keccak256 EdDSA seed as `0x` hex. Decode to raw bytes before
     * re-feeding to zk-kit/Semaphore — the hex string derives a different key
     * (`DERIVATION.md` §12.4).
     */
    seed: Hex
    /** The Baby Jubjub EdDSA private scalar, pruned per `deriveSecretScalar`. */
    secretScalar: bigint
    /** The Baby Jubjub public key point, `[x, y]`. */
    publicKey: [bigint, bigint]
    /** The Semaphore v4 identity commitment: `poseidon2([x, y])`. */
    commitment: bigint
}
