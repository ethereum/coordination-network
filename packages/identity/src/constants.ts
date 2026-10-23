/**
 * Normative constants for the `v2` key derivation scheme. Changing any of
 * these changes every derived key and `networkId`, so they MUST NOT change
 * without a version bump (new `KEY_DERIVATION_VERSION` and domain strings).
 */

export const KEY_DERIVATION_VERSION = "v2" as const

/** Fixed domain-separation message signed by {@link signDerivationMessage}. */
export const FIXED_DOMAIN_MSG = "coordination-network/identity/v1" as const

/** Domain-separation tag for deriving the account keypair from a device secret. */
export const DOMAIN_ACCOUNT = "coordination-network/identity/v1/account" as const

/** Domain-separation tag for deriving the auth keypair. */
export const DOMAIN_AUTH = "coordination-network/identity/v1/auth" as const

/** Domain-separation tag for deriving the Baby Jubjub EdDSA seed (the "fifth key") from the hardware ECDH shared secret. */
export const DOMAIN_EDDSA = "coordination-network/identity/v1/eddsa" as const

/** Distinct Baby Jubjub seed for public paymaster membership; never use the credential holder key as a group leaf. */
export const DOMAIN_PAYMASTER = "coordination-network/identity/v1/paymaster" as const

/** Domain-separation message hashed to the fixed NUMS P-256 peer point `Q` for the fifth-key ECDH (`eddsa-peer.ts`). */
export const DOMAIN_EDDSA_PEER = "coordination-network/identity/v1/eddsa/peer" as const

/** Domain-separation tag prefixed to `X || Y` when hashing a user `networkId`. */
export const DOMAIN_NETWORK_ID = "coordination-network/identity/v2/network-id" as const

/**
 * Byte length of `nonce` and `networkId` in the binding messages — fixed at
 * 32 so the 128-byte device and 96-byte account messages are injective.
 */
export const BINDING_NONCE_LENGTH = 32 as const

/** SEC1-compressed secp256k1 public key length. */
export const COMPRESSED_PUBLIC_KEY_LENGTH = 33 as const

/** ERC-6538 scheme 1 meta-stealth address: compressed spending ‖ viewing public keys. */
export const META_STEALTH_ADDRESS_LENGTH = 66 as const

/** ERC-5564 offchain display prefix — never stored onchain. */
export const META_STEALTH_URI_PREFIX = "st:eth:" as const

/** ERC-5564 scheme id for secp256k1 with view tags. */
export const ERC_5564_SCHEME_ID = 1 as const
