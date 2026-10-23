import { p256 } from "@noble/curves/p256"
import type { Hex } from "./types"
import { bytesToBase64url, bytesToHex, prependUncompressedPrefix, toBytes } from "./bytes"
import { sha256 } from "@noble/hashes/sha2"
import { InvalidBindingInputError } from "./errors"

/**
 * Normalizes a P-256 `confirmationKey` to its raw 64-byte `X || Y`
 * coordinates, validating that the point is on the curve. Accepts a 65-byte
 * SEC1 uncompressed, 33-byte compressed, or 64-byte raw `X || Y` encoding.
 */
export function normalizeConfirmationKey(confirmationKey: Uint8Array | Hex): Uint8Array {
    let bytes: Uint8Array

    try {
        bytes = toBytes(confirmationKey)
    } catch {
        throw new InvalidBindingInputError(
            "normalizeConfirmationKey: expected raw bytes or a well-formed 0x-prefixed hex string"
        )
    }

    if (bytes.length !== 33 && bytes.length !== 64 && bytes.length !== 65) {
        throw new InvalidBindingInputError(
            "normalizeConfirmationKey: expected a 65-byte uncompressed, 33-byte compressed, or 64-byte raw P-256 public key"
        )
    }

    const sec1Bytes = bytes.length === 64 ? prependUncompressedPrefix(bytes) : bytes

    try {
        return p256.ProjectivePoint.fromHex(sec1Bytes).toRawBytes(false).slice(1)
    } catch {
        throw new InvalidBindingInputError("normalizeConfirmationKey: not a valid on-curve P-256 public key")
    }
}

/**
 * Computes the `confirmationKeyHash` embedded in the account binding message.
 *
 * NORMATIVE: the RFC 7638 JWK thumbprint of the P-256 confirmation key, i.e.
 * `sha256(utf8('{"crv":"P-256","kty":"EC","x":<base64url X>,"y":<base64url Y>}'))`
 */
export function computeConfirmationKeyHash(confirmationKey: Uint8Array | Hex): Hex {
    const coordinates = normalizeConfirmationKey(confirmationKey)
    const x = bytesToBase64url(coordinates.slice(0, 32))
    const y = bytesToBase64url(coordinates.slice(32))

    return bytesToHex(sha256(`{"crv":"P-256","kty":"EC","x":"${x}","y":"${y}"}`))
}
