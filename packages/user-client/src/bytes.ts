import {
    hexToBytes as nobleHexToBytes,
    bytesToHex as nobleBytesToHex,
    concatBytes as nobleConcatBytes
} from "@noble/hashes/utils"
import { Hex } from "./types"
import { UserClientError } from "./errors"

/** Parses a 0x-prefixed hex string into bytes. Throws on missing prefix, odd length, or non-hex chars. */
export function hexToBytes(hex: Hex): Uint8Array {
    if (typeof hex !== "string" || !hex.startsWith("0x")) {
        throw new UserClientError("INVALID_INPUT", `Expected a 0x-prefixed hex string, got ${typeof hex}`)
    }
    const body = hex.slice(2)
    if (body.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(body)) {
        throw new UserClientError("INVALID_INPUT", `Malformed hex string of length ${body.length}`)
    }
    return nobleHexToBytes(body)
}

export function bytesToHex(bytes: Uint8Array): Hex {
    return `0x${nobleBytesToHex(bytes)}` as Hex
}

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
    return nobleConcatBytes(...arrays)
}

/** Big-endian 32-byte word encoding of a non-negative safe-integer uint256, as abi.encode would produce. */
export function numberToWord(value: number): Uint8Array {
    if (!Number.isSafeInteger(value) || value < 0) {
        throw new UserClientError("INVALID_INPUT", `Expected a non-negative safe integer, got ${typeof value} ${value}`)
    }
    const word = new Uint8Array(32)
    let remaining = BigInt(value)
    for (let i = 31; i >= 0 && remaining > 0n; i -= 1) {
        word[i] = Number(remaining & 0xffn)
        remaining >>= 8n
    }
    return word
}

/** Left-pads a 20-byte address into a 32-byte word, as abi.encode would produce. */
export function addressToWord(address: Hex): Uint8Array {
    const addressBytes = hexToBytes(address)
    if (addressBytes.length !== 20) {
        throw new UserClientError("INVALID_INPUT", `Expected a 20-byte address, got ${addressBytes.length} bytes`)
    }
    const word = new Uint8Array(32)
    word.set(addressBytes, 12)
    return word
}
