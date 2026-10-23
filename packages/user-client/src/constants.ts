/** ERC-6538 scheme 1 (secp256k1 stealth addresses), the schemeId field of the consent struct. */
export const SCHEME_ID = 1 as const
/** networkId is a bytes32 on chain, and abi.encode splices it in as one word. */
export const NETWORK_ID_LENGTH = 32
/** r || s || v, the 65-byte Ethereum signature layout. */
export const SIGNATURE_LENGTH = 65
/** keccak256 output, the only thing this package will sign. */
export const DIGEST_LENGTH = 32
/** Ethereum transaction hash, as HttpSubmissionError's 201 branch expects it. */
export const TX_HASH_LENGTH = 32
/** Wire-format version of RegistrationRequest. */
export const REQUEST_VERSION = "v1" as const
export const IDENTITY_REGISTRY_DOMAIN_NAME = "IdentityRegistry"
export const IDENTITY_REGISTRY_DOMAIN_VERSION = "1"
/** Signed by the user as consent to register; the member server verifies it, the contract never reads it. */
export const REGISTER_IDENTITY_TYPE = "RegisterIdentity(bytes32 networkId,uint256 schemeId,bytes metaStealthAddress)"
export const EIP712_DOMAIN_TYPE = "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
