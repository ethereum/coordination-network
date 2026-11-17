import { sha256 } from "@noble/hashes/sha2"
import type { LeanIMTPlusHashFunctions } from "@zk-kit/lean-imt-plus"
import type { RevocationScheme } from "../types"

export const SHA256_VALUE_BOUND = 1n << 256n

const WORD_BYTES = 32

/** `sha256` over 32-byte big-endian words, as Solidity's `sha256(abi.encodePacked(...))` of `uint256`s. */
function sha256Words(...values: bigint[]): bigint {
    const message = new Uint8Array(WORD_BYTES * values.length)

    values.forEach((value, word) => {
        if (value < 0n || value >= SHA256_VALUE_BOUND) {
            throw new Error("RevocationRegistry: a SHA-256 hash input must be in [0, 2^256)")
        }

        let rest = value

        for (let i = WORD_BYTES - 1; i >= 0; i--) {
            message[word * WORD_BYTES + i] = Number(rest & 0xffn)
            rest >>= 8n
        }
    })

    let result = 0n

    for (const byte of sha256(message)) {
        result = (result << 8n) | BigInt(byte)
    }

    return result
}

/** `sha256(a || b)` over 32-byte big-endian words: the internal node hash. */
export function sha256Hash2(a: bigint, b: bigint): bigint {
    return sha256Words(a, b)
}

/** `sha256(a || b || c)` over 32-byte big-endian words: the leaf hash. */
export function sha256Hash3(a: bigint, b: bigint, c: bigint): bigint {
    return sha256Words(a, b, c)
}

/**
 * `leaf` is `sha256(value || nextValue || TAG_LEAF)`, `internal` is
 * `sha256(left || right)`. The message lengths domain-separate them.
 */
export const sha256Hashes: LeanIMTPlusHashFunctions<bigint> = {
    leaf: sha256Hash3,
    internal: sha256Hash2
}

/**
 * Matches `Sha256Revocation` on chain and zk-kit's `LeanIMTPlusSha256` circuit,
 * which uses 128-bit limbs and so works over BN254 or secq256r1 (OpenAC).
 */
export const sha256Scheme: RevocationScheme = {
    hashes: sha256Hashes,
    bound: SHA256_VALUE_BOUND,
    boundDescription: "SHA-256 value bound of 2^256"
}
