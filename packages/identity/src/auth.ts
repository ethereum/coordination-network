import type { Hex, Secp256k1Keypair } from "./types"
import { DOMAIN_AUTH } from "./constants"
import { normalizeSignature64 } from "./account"
import { hashToScalar } from "./hash-to-scalar"
import { scalarToKeypair } from "./keypair"

/**
 * Derives the secp256k1 auth keypair from the 64-byte compact
 * derivation-message signature.
 *
 * NORMATIVE: `authPrivKey = hashToScalar(DOMAIN_AUTH, sig64)`.
 *
 * `sig64` is unauthenticated — prefer {@link deriveKeys} (see `DERIVATION.md`).
 */
export function deriveAuthKeypair(sig64: Uint8Array | Hex): Secp256k1Keypair {
    const signature = normalizeSignature64(sig64)
    const scalar = hashToScalar(DOMAIN_AUTH, signature)

    return scalarToKeypair(scalar)
}
