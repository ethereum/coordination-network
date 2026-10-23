import { keccak_256 } from "@noble/hashes/sha3"
import { concatBytes, utf8ToBytes } from "./bytes"
import { DerivationFailureError } from "./errors"
import { isValidScalar } from "./keypair"

/** A 32-byte-output hash function, e.g. `keccak_256`. */
export type HashFn = (input: Uint8Array) => Uint8Array

/** {@link hashToScalar} with an injectable hash, letting tests drive the reject/retry branch. */
export function hashToScalarWith(hashFn: HashFn, tag: string, input: Uint8Array): Uint8Array {
    const tagBytes = utf8ToBytes(tag)

    for (let counter = 0; counter <= 255; counter += 1) {
        const candidate = hashFn(concatBytes(tagBytes, input, Uint8Array.of(counter)))

        if (isValidScalar(candidate)) {
            return candidate
        }
    }

    throw new DerivationFailureError("hashToScalar: exhausted all 256 counter values without a valid scalar")
}

/**
 * Deterministically derives a secp256k1 private scalar from a domain tag and
 * input bytes.
 *
 * NORMATIVE: for `counter = 0..255`, return the first
 * `keccak256(utf8(tag) || input || [counter])` whose big-endian value lies in
 * `[1, n)`. Out-of-range candidates have probability ~`2^-128`, so exhaustion
 * is unreachable.
 */
export function hashToScalar(tag: string, input: Uint8Array): Uint8Array {
    return hashToScalarWith(keccak_256, tag, input)
}
