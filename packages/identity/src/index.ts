/**
 * `@coordination-network/identity` — deterministic device key derivation
 * (`networkId` and four secp256k1 keys from one device secret, plus a
 * hardware-rooted Baby Jubjub EdDSA fifth key) and the credential dual
 * proof-of-possession binding.
 */

export * from "./types"
export * from "./constants"
export * from "./errors"
export {
    base64urlToBytes,
    bytesToBase64url,
    bytesToHex,
    hexToBytes,
    normalizeDeviceSecret,
    normalizeEcdhSharedSecret
} from "./bytes"
export { generateDeviceSecret } from "./device-secret"
export { hashToScalar, hashToScalarWith } from "./hash-to-scalar"
export type { HashFn } from "./hash-to-scalar"
export { isValidScalar, scalarToKeypair } from "./keypair"
export { deriveAccountKeypair, signDerivationMessage } from "./account"
export { deriveStealthKeys } from "./stealthAddresses/deriveStealthKeys"
export { computeSharedSecret } from "./stealthAddresses/computeSharedSecret"
export { getViewTag } from "./stealthAddresses/getViewTag"
export { getStealthPublicKey } from "./stealthAddresses/getStealthPublicKey"
export { publicKeyToAddress } from "./stealthAddresses/publicKeyToAddress"
export { generateEphemeralKey } from "./stealthAddresses/generateEphemeralKey"
export { generateStealthAddress } from "./stealthAddresses/generateStealthAddress"
export { generateStealthPrivateKey } from "./stealthAddresses/generateStealthPrivateKey"
export { checkStealthAddress } from "./stealthAddresses/checkStealthAddress"
export { validateMetaStealthAddress } from "./stealthAddresses/validateMetaStealthAddress"
export { encodeMetaStealthAddress } from "./stealthAddresses/encodeMetaStealthAddress"
export { encodeMetaStealthAddressUri } from "./stealthAddresses/encodeMetaStealthAddressUri"
export { metaStealthAddressUri } from "./stealthAddresses/metaStealthAddressUri"
export { decodeMetaStealthAddress } from "./stealthAddresses/decodeMetaStealthAddress"
export { buildAnnouncement } from "./stealthAddresses/buildAnnouncement"
export { deriveAuthKeypair } from "./auth"
export { deriveEddsaKeypair, derivePaymasterKeypair } from "./eddsa"
export { EDDSA_PEER_POINT_HEX, eddsaPeerPointBytes, computeEddsaPeerPoint } from "./eddsa-peer"
export { computeNetworkId, computeMemberNetworkId } from "./network-id"
export { deriveKeys, deriveNetworkId } from "./derive"
export { normalizeConfirmationKey, computeConfirmationKeyHash } from "./confirmation-key"
export {
    buildDeviceBindingMessage,
    buildAccountBindingMessage,
    buildBindingMessages,
    signAccountBinding,
    verifyAccountBindingSignature,
    verifyDeviceBindingSignature,
    verifyCredentialBinding
} from "./binding"
