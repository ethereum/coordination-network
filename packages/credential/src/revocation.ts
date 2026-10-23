import { inPrimeOrderSubgroup } from "@coordination-network/issuer-set"
import { Identity } from "@semaphore-protocol/identity"
import { bytesToHex, randomBytes } from "@noble/hashes/utils"
import { EddsaPublicKey, EddsaSignature } from "./types"

/**
 * Device-side revocation material (spec 08). r is 32 random bytes, generated
 * on the device, never leaving it. Everything below takes r as Uint8Array,
 * never as a hex string: the two encodings derive different commitments
 * (Semaphore hashes the raw input), and the regression test holds that line.
 */

function assertSecret(r: Uint8Array): void {
    if (r.length !== 32) {
        throw new Error("revocation secret must be 32 bytes")
    }
}

export function nonceToBigint(nonce: Uint8Array): bigint {
    if (nonce.length === 0) {
        throw new Error("nonce must not be empty")
    }
    return BigInt(`0x${bytesToHex(nonce)}`)
}

/** Generates a fresh 32-byte revocation secret r. Device-side only. */
export function generateRevocationSecret(): Uint8Array {
    return randomBytes(32)
}

/** commitment = new Identity(r).commitment (Semaphore V4). */
export function deriveRevocationCommitment(r: Uint8Array): bigint {
    assertSecret(r)
    return new Identity(r).commitment
}

/**
 * Signs the issuer's challenge nonce with the Baby Jubjub EdDSA key behind
 * r, proving the device owns the commitment it asks the issuer to embed.
 */
export function signCommitmentOwnership(
    r: Uint8Array,
    nonce: Uint8Array
): { publicKey: EddsaPublicKey; signature: EddsaSignature } {
    assertSecret(r)
    const identity = new Identity(r)
    const signature = identity.signMessage(nonceToBigint(nonce))
    return {
        publicKey: [identity.publicKey[0], identity.publicKey[1]],
        signature: { R8: [signature.R8[0], signature.R8[1]], S: signature.S }
    }
}

/**
 * Issuer-side check: requires a prime-order public key, verifies the EdDSA
 * signature over the nonce, recomputes the commitment from the public key, and
 * compares it to the claimed one. A low-order key is refused because its
 * signatures need no secret.
 */
export function verifyCommitmentOwnership(params: {
    commitment: bigint
    publicKey: EddsaPublicKey
    signature: EddsaSignature
    nonce: Uint8Array
}): boolean {
    try {
        if (!inPrimeOrderSubgroup(params.publicKey)) {
            return false
        }
        if (!Identity.verifySignature(nonceToBigint(params.nonce), params.signature, params.publicKey)) {
            return false
        }
        return Identity.generateCommitment(params.publicKey) === params.commitment
    } catch {
        return false
    }
}
