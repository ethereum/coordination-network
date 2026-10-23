import { secp256k1 } from "@noble/curves/secp256k1"
import { keccak_256 } from "@noble/hashes/sha3"
import type { Hex, Secp256k1Keypair } from "./types"
import { DOMAIN_ACCOUNT, FIXED_DOMAIN_MSG } from "./constants"
import { bytesToHex, concatBytes, normalizeDeviceSecret, toBytes, utf8ToBytes } from "./bytes"
import { hashToScalar } from "./hash-to-scalar"
import { scalarToKeypair } from "./keypair"

/**
 * Derives the root secp256k1 account keypair from a 32-byte device secret.
 *
 * NORMATIVE: `accountPrivKey = hashToScalar(DOMAIN_ACCOUNT, deviceSecret)`.
 */
export function deriveAccountKeypair(deviceSecret: Uint8Array | Hex): Secp256k1Keypair {
    const secret = normalizeDeviceSecret(deviceSecret)
    const scalar = hashToScalar(DOMAIN_ACCOUNT, secret)

    return scalarToKeypair(scalar)
}

/**
 * Normalizes a 64-byte compact ECDSA signature (`r || s`) to raw bytes.
 *
 * @internal
 */
export function normalizeSignature64(sig64: Uint8Array | Hex): Uint8Array {
    const bytes = toBytes(sig64)

    if (bytes.length !== 64) {
        throw new TypeError("normalizeSignature64: expected a 64-byte compact signature (r || s)")
    }

    return bytes
}

/**
 * EIP-191 personal-sign digest:
 * `keccak256(utf8("\x19Ethereum Signed Message:\n" + decimalByteLength) || message)`.
 *
 * @internal
 */
export function eip191Digest(message: Uint8Array): Uint8Array {
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${String(message.length)}`)

    return keccak_256(concatBytes(prefix, message))
}

/**
 * Signs the fixed derivation message with the account private key.
 *
 * NORMATIVE: the EIP-191 digest of {@link FIXED_DOMAIN_MSG}, signed with
 * RFC-6979 deterministic ECDSA (`lowS: true`, no `extraEntropy`), returned as
 * the 64-byte compact `r || s` encoding.
 */
export function signDerivationMessage(accountPrivateKey: Hex | Uint8Array): Hex {
    const privateKey = toBytes(accountPrivateKey)
    const digest = eip191Digest(utf8ToBytes(FIXED_DOMAIN_MSG))
    const signature = secp256k1.sign(digest, privateKey, { lowS: true })

    return bytesToHex(signature.toCompactRawBytes())
}
