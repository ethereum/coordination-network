import { sha256 } from "@noble/hashes/sha2"
import type { IssuerScheme } from "../types"

export const SHA256_VALUE_BOUND = 1n << 256n

const WORD_BYTES = 32

/** `sha256(a || b)` over 32-byte big-endian words, as Solidity's `sha256(abi.encodePacked(a, b))`. */
export function sha256Hash2(a: bigint, b: bigint): bigint {
    const message = new Uint8Array(2 * WORD_BYTES)
    const words = [a, b]

    for (let word = 0; word < words.length; word++) {
        if (words[word] < 0n || words[word] >= SHA256_VALUE_BOUND) {
            throw new Error("IssuerRegistry: a SHA-256 hash input must be in [0, 2^256)")
        }

        let rest = words[word]

        for (let i = WORD_BYTES - 1; i >= 0; i--) {
            message[word * WORD_BYTES + i] = Number(rest & 0xffn)
            rest >>= 8n
        }
    }

    let result = 0n

    for (const byte of sha256(message)) {
        result = (result << 8n) | BigInt(byte)
    }

    return result
}

/** Matches `Sha256IssuerRegistry` on chain and zk-kit's `binary-merkle-root-sha256` circuit. */
export const sha256Scheme: IssuerScheme = {
    hash: sha256Hash2,
    bound: SHA256_VALUE_BOUND,
    boundDescription: "SHA-256 value bound of 2^256"
}
