import { keccak_256 } from "@noble/hashes/sha3"
import type { Hex, Secp256k1Keypair } from "../types"
import { normalizeSignature64 } from "../account"
import { scalarToKeypair } from "../keypair"

/**
 * Derives the spending and viewing secp256k1 keypairs from the 64-byte
 * compact derivation-message signature.
 *
 * NORMATIVE (FluidKey `generateKeysFromSignature` semantics): with
 * `r = sig[0..32]` and `s = sig[32..64]`, `spendingPrivKey = keccak256(r)`
 * and `viewingPrivKey = keccak256(s)`. No reject/retry — the hash output is
 * used directly and validated to be in `[1, n)` by {@link scalarToKeypair}.
 *
 * `sig64` is unauthenticated — prefer {@link deriveKeys} (see `DERIVATION.md`).
 */
export function deriveStealthKeys(sig64: Uint8Array | Hex): {
    spending: Secp256k1Keypair
    viewing: Secp256k1Keypair
} {
    const signature = normalizeSignature64(sig64)

    const r = signature.slice(0, 32)
    const s = signature.slice(32, 64)

    return {
        spending: scalarToKeypair(keccak_256(r)),
        viewing: scalarToKeypair(keccak_256(s))
    }
}
