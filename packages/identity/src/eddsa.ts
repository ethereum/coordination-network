/** Baby Jubjub EdDSA "fifth key" derivation — see `DERIVATION.md` §12. */

import { keccak_256 } from "@noble/hashes/sha3"
import { deriveSecretScalar, derivePublicKey } from "@zk-kit/eddsa-poseidon"
import { poseidon2 } from "poseidon-lite/poseidon2"
import type { EddsaKeypair, Hex } from "./types"
import { DOMAIN_EDDSA, DOMAIN_PAYMASTER } from "./constants"
import { bytesToHex, concatBytes, normalizeEcdhSharedSecret, utf8ToBytes } from "./bytes"

function deriveKeypair(ecdhSharedSecret: Uint8Array | Hex, domain: string): EddsaKeypair {
    const secret = normalizeEcdhSharedSecret(ecdhSharedSecret)
    const seed = keccak_256(concatBytes(utf8ToBytes(domain), secret))

    const secretScalar = deriveSecretScalar(seed)
    const publicKey = derivePublicKey(seed)
    const commitment = poseidon2(publicKey)

    return {
        seed: bytesToHex(seed),
        secretScalar,
        publicKey,
        commitment
    }
}

/**
 * Derives the Baby Jubjub EdDSA keypair and Semaphore-v4 identity commitment
 * (the "fifth key"), rooted in a hardware ECDH shared secret.
 *
 * NORMATIVE (`DERIVATION.md` §12): `ecdhSharedSecret = X(hwPriv · Q)` for the
 * fixed NUMS peer point `Q` (`eddsa-peer.ts`), computed natively by the
 * caller — the library never talks to the Keystore, it only takes the raw
 * 32-byte result. `seed = keccak256(utf8(DOMAIN_EDDSA) || ecdhSharedSecret)`,
 * fed to `@zk-kit/eddsa-poseidon` as raw bytes (MUST NOT be the hex string,
 * see §12.4); `commitment = poseidon2([x, y])`.
 *
 * @throws {InvalidEcdhSecretError} if `ecdhSharedSecret` is not exactly 32 bytes
 */
export function deriveEddsaKeypair(ecdhSharedSecret: Uint8Array | Hex): EddsaKeypair {
    return deriveKeypair(ecdhSharedSecret, DOMAIN_EDDSA)
}

/** Derives a separate Semaphore identity whose public commitment may join the paymaster group. */
export function derivePaymasterKeypair(ecdhSharedSecret: Uint8Array | Hex): EddsaKeypair {
    return deriveKeypair(ecdhSharedSecret, DOMAIN_PAYMASTER)
}
