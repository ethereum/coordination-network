/**
 * Shared test helpers. All "random" values are seeded keccak counters (never
 * `Math.random`), so every run is byte-for-byte reproducible.
 */

import { secp256k1 } from "@noble/curves/secp256k1"
import { p256 } from "@noble/curves/nist.js"
import { keccak_256 } from "@noble/hashes/sha3"
import type { Hex } from "../src/types"
import { FIXED_DOMAIN_MSG } from "../src/constants"
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "../src/bytes"

export const N = secp256k1.CURVE.n
export const P256_N = p256.CURVE.n

/** Deterministic 32-byte device secret for a given index. */
export function seededSecret(index: number): Hex {
    return bytesToHex(keccak_256(utf8ToBytes(`coordination-network/identity/test-vector-seed/v1:${index}`)))
}

/** The fixed EIP-191 digest over {@link FIXED_DOMAIN_MSG}, rebuilt as the library computes it. */
export const DERIVATION_DIGEST: Uint8Array = (() => {
    const message = utf8ToBytes(FIXED_DOMAIN_MSG)
    const prefix = utf8ToBytes(`\x19Ethereum Signed Message:\n${String(message.length)}`)

    return keccak_256(concatBytes(prefix, message))
})()

/** Signs the derivation digest, exposing the recovery id the compact form drops (`v = 27 + recovery`). */
export function signWithRecovery(accountPrivateKey: Hex): {
    compact: Hex
    r: Hex
    s: Hex
    recovery: number
    v: number
} {
    const signature = secp256k1.sign(DERIVATION_DIGEST, hexToBytes(accountPrivateKey), { lowS: true })
    const compactBytes = signature.toCompactRawBytes()

    return {
        compact: bytesToHex(compactBytes),
        r: bytesToHex(compactBytes.slice(0, 32)),
        s: bytesToHex(compactBytes.slice(32, 64)),
        recovery: signature.recovery,
        v: 27 + signature.recovery
    }
}

/** The 65-byte `r || s || v` hex signature FluidKey's `generateKeysFromSignature` expects. */
export function fluidkeySignatureHex(sig: { compact: Hex; v: number }): Hex {
    return `${sig.compact}${sig.v.toString(16).padStart(2, "0")}` as Hex
}

/** Deterministic 32-byte binding nonce for a given index. */
export function seededNonce(index: number): Uint8Array {
    return keccak_256(utf8ToBytes(`coordination-network/identity/test-binding-nonce/v1:${index}`))
}

function bigIntToBytes32(value: bigint): Uint8Array {
    const bytes = new Uint8Array(32)
    let remaining = value

    for (let i = 31; i >= 0; i -= 1) {
        bytes[i] = Number(remaining & 0xffn)
        remaining >>= 8n
    }

    return bytes
}

/**
 * Deterministic P-256 test keypair (the hardware `confirmationKey`
 * stand-in), seed hash reduced into `[1, n)`.
 */
export function seededP256Key(index: number): { privateKey: Uint8Array; publicKey: Uint8Array } {
    const seed = keccak_256(utf8ToBytes(`coordination-network/identity/test-p256-key/v1:${index}`))
    const scalar = (BigInt(bytesToHex(seed)) % (P256_N - 1n)) + 1n
    const privateKey = bigIntToBytes32(scalar)
    const publicKey = p256.getPublicKey(privateKey, false)

    return { privateKey, publicKey }
}

/** Deterministic opaque 32-byte value, standing in for a commitment the binding layer never interprets. */
export function seededCommitment(label: string, index: number): Uint8Array {
    return keccak_256(utf8ToBytes(`coordination-network/identity/test-${label}/v1:${index}`))
}
