/**
 * Credential dual proof-of-possession binding — see `DERIVATION.md` §11.
 *
 * NORMATIVE layouts:
 * ```
 * deviceBindingMessage  = nonce(32) || networkId(32) || holderKeyCommitment(32) || requestCommitment(32)
 * accountBindingMessage = nonce(32) || confirmationKeyHash(32) || networkId(32)
 * ```
 *
 * B (P-256) signs the 128-byte device message; A (secp256k1) signs the 96-byte account message.
 *
 * `requestCommitment` is opaque here: the credential layer defines it and
 * binds the issuer and scope shown at consent into it.
 *
 * NORMATIVE MUST: the device signs a locally-derived `networkId`, never one
 * supplied by the issuance request. Every function here except the two
 * low-level builders and {@link verifyDeviceBindingSignature} enforces this
 * by deriving `networkId` internally rather than accepting it as a parameter.
 */

import { secp256k1 } from "@noble/curves/secp256k1"
import { p256 } from "@noble/curves/p256"
import type { Hex } from "./types"
import { BINDING_NONCE_LENGTH } from "./constants"
import { bytesToHex, concatBytes, prependUncompressedPrefix, toBytes } from "./bytes"
import { eip191Digest, normalizeSignature64 } from "./account"
import { computeNetworkId } from "./network-id"
import { normalizeConfirmationKey, computeConfirmationKeyHash } from "./confirmation-key"
import { InvalidBindingInputError } from "./errors"

function toBindingBytes(value: Uint8Array | Hex, label: string): Uint8Array {
    try {
        return toBytes(value)
    } catch {
        throw new InvalidBindingInputError(`${label}: expected raw bytes or a well-formed 0x-prefixed hex string`)
    }
}

function toBindingHash32(value: Uint8Array | Hex, label: string): Uint8Array {
    const bytes = toBindingBytes(value, label)
    if (bytes.length !== 32) throw new InvalidBindingInputError(`${label}: expected exactly 32 bytes`)
    return bytes
}

function decodeAndValidateNonceAndNetworkId(
    nonce: Uint8Array | Hex,
    networkId: Uint8Array | Hex
): { nonceBytes: Uint8Array; networkIdBytes: Uint8Array } {
    const nonceBytes = toBindingBytes(nonce, "nonce")
    const networkIdBytes = toBindingBytes(networkId, "networkId")

    if (nonceBytes.length !== BINDING_NONCE_LENGTH) {
        throw new InvalidBindingInputError(`nonce: expected exactly ${BINDING_NONCE_LENGTH} bytes`)
    }

    if (networkIdBytes.length !== BINDING_NONCE_LENGTH) {
        throw new InvalidBindingInputError(`networkId: expected exactly ${BINDING_NONCE_LENGTH} bytes`)
    }

    return { nonceBytes, networkIdBytes }
}

/**
 * Normalizes an `accountPublicKey` (65-byte uncompressed, 33-byte compressed,
 * or 64-byte raw `X || Y`) to its 65-byte SEC1 uncompressed encoding,
 * validating that it is on the secp256k1 curve.
 */
function normalizeAccountPublicKey(accountPublicKey: Uint8Array | Hex): Uint8Array {
    const bytes = toBindingBytes(accountPublicKey, "accountPublicKey")

    if (bytes.length !== 33 && bytes.length !== 64 && bytes.length !== 65) {
        throw new InvalidBindingInputError(
            "accountPublicKey: expected a 65-byte uncompressed, 33-byte compressed, or 64-byte raw secp256k1 public key"
        )
    }

    const sec1Bytes = bytes.length === 64 ? prependUncompressedPrefix(bytes) : bytes

    try {
        return secp256k1.ProjectivePoint.fromHex(sec1Bytes).toRawBytes(false)
    } catch {
        throw new InvalidBindingInputError("accountPublicKey: not a valid on-curve secp256k1 public key")
    }
}

function normalizeAccountSignature(signature: Uint8Array | Hex): Uint8Array {
    try {
        return normalizeSignature64(signature)
    } catch {
        throw new InvalidBindingInputError("accountSignature: expected a 64-byte compact secp256k1 signature (r || s)")
    }
}

/**
 * Parses a P-256 signature in either accepted platform encoding: 64-byte raw
 * `r || s` (WebCrypto) or DER (Secure Enclave / Android Keystore). The DER
 * `0x30` tag is checked before length because a genuine DER signature can
 * itself be exactly 64 bytes.
 */
function parseDeviceSignature(signature: Uint8Array | Hex): ReturnType<typeof p256.Signature.fromCompact> {
    const bytes = toBindingBytes(signature, "deviceSignature")

    if (bytes[0] === 0x30) {
        try {
            return p256.Signature.fromDER(bytes)
        } catch {
            // not valid DER; try compact
        }
    }

    if (bytes.length === 64) {
        try {
            return p256.Signature.fromCompact(bytes)
        } catch {
            // not valid compact either; reject below
        }
    }

    throw new InvalidBindingInputError(
        "deviceSignature: expected a 64-byte compact (r || s) or DER-encoded P-256 signature"
    )
}

/**
 * Builds the 128-byte `deviceBindingMessage`:
 * `nonce(32) || networkId(32) || holderKeyCommitment(32) || requestCommitment(32)`.
 *
 * Low-level, spec-literal builder — prefer {@link buildBindingMessages},
 * which enforces the locally-derived-`networkId` MUST structurally.
 */
export function buildDeviceBindingMessage(
    nonce: Uint8Array | Hex,
    networkId: Uint8Array | Hex,
    holderKeyCommitment: Uint8Array | Hex,
    requestCommitment: Uint8Array | Hex
): Uint8Array {
    const { nonceBytes, networkIdBytes } = decodeAndValidateNonceAndNetworkId(nonce, networkId)
    const holderBytes = toBindingHash32(holderKeyCommitment, "holderKeyCommitment")
    const requestBytes = toBindingHash32(requestCommitment, "requestCommitment")
    return concatBytes(nonceBytes, networkIdBytes, holderBytes, requestBytes)
}

/**
 * Builds the 96-byte `accountBindingMessage`:
 * `nonce(32) || confirmationKeyHash(32) || networkId(32)`.
 *
 * Low-level, spec-literal builder — see {@link buildBindingMessages} for the
 * wallet-side entry point.
 */
export function buildAccountBindingMessage(
    nonce: Uint8Array | Hex,
    confirmationKey: Uint8Array | Hex,
    networkId: Uint8Array | Hex
): Uint8Array {
    const { nonceBytes, networkIdBytes } = decodeAndValidateNonceAndNetworkId(nonce, networkId)
    const confirmationKeyHash = toBytes(computeConfirmationKeyHash(confirmationKey))

    return concatBytes(nonceBytes, confirmationKeyHash, networkIdBytes)
}

/**
 * Wallet-side entry point: builds both binding messages with `networkId`
 * derived internally from the account's own public key, so a caller cannot
 * supply a `networkId` from elsewhere even by mistake.
 */
export function buildBindingMessages(
    nonce: Uint8Array | Hex,
    accountUncompressedPublicKey: Uint8Array | Hex,
    confirmationKey: Uint8Array | Hex,
    holderKeyCommitment: Uint8Array | Hex,
    requestCommitment: Uint8Array | Hex
): { networkId: Hex; deviceBindingMessage: Uint8Array; accountBindingMessage: Uint8Array } {
    let networkId: Hex

    try {
        networkId = computeNetworkId(accountUncompressedPublicKey)
    } catch {
        throw new InvalidBindingInputError(
            "accountUncompressedPublicKey: expected a 65-byte 0x04-prefixed or 64-byte raw uncompressed secp256k1 public key"
        )
    }

    const deviceBindingMessage = buildDeviceBindingMessage(nonce, networkId, holderKeyCommitment, requestCommitment)
    const accountBindingMessage = buildAccountBindingMessage(nonce, confirmationKey, networkId)

    return { networkId, deviceBindingMessage, accountBindingMessage }
}

/**
 * Produces `sig_A`: the EIP-191 signature over the `accountBindingMessage`,
 * with `networkId` derived internally from the account private key. Same
 * signing posture as {@link signDerivationMessage} (RFC-6979 deterministic,
 * `lowS: true`, no `extraEntropy`, 64-byte compact `r || s`).
 */
export function signAccountBinding(
    accountPrivateKey: Hex | Uint8Array,
    nonce: Uint8Array | Hex,
    confirmationKey: Uint8Array | Hex
): { signature: Hex; networkId: Hex } {
    const privateKeyBytes = toBytes(accountPrivateKey)
    const uncompressedPublicKey = secp256k1.getPublicKey(privateKeyBytes, false)
    const networkId = computeNetworkId(uncompressedPublicKey)

    const message = buildAccountBindingMessage(nonce, confirmationKey, networkId)
    const digest = eip191Digest(message)
    const signature = secp256k1.sign(digest, privateKeyBytes, { lowS: true })

    return { signature: bytesToHex(signature.toCompactRawBytes()), networkId }
}

/**
 * Issuer-side verification of `sig_A`, with `networkId` derived internally
 * from `accountPublicKey` — never accepted as a parameter.
 *
 * Malformed inputs throw {@link InvalidBindingInputError}; a well-formed
 * signature that fails to verify returns `false`.
 */
export function verifyAccountBindingSignature({
    nonce,
    confirmationKey,
    accountPublicKey,
    signature
}: {
    nonce: Uint8Array | Hex
    confirmationKey: Uint8Array | Hex
    accountPublicKey: Uint8Array | Hex
    signature: Uint8Array | Hex
}): boolean {
    const publicKeyBytes = normalizeAccountPublicKey(accountPublicKey)
    const networkId = computeNetworkId(publicKeyBytes)

    const message = buildAccountBindingMessage(nonce, confirmationKey, networkId)
    const digest = eip191Digest(message)
    const signatureBytes = normalizeAccountSignature(signature)

    return secp256k1.verify(signatureBytes, digest, publicKeyBytes, { lowS: true })
}

/**
 * Issuer-side verification of `sig_B` (hardware P-256) over the
 * `deviceBindingMessage`. NORMATIVE MUST: `networkId` — not derivable here,
 * since `sig_B` is independent of the account key — must be the device's
 * locally-derived value; prefer {@link verifyCredentialBinding}.
 *
 * `prehash: true` (signers hash SHA-256 internally); `lowS: false` (hardware
 * signatures aren't s-normalized — `DERIVATION.md` §11.4).
 */
export function verifyDeviceBindingSignature({
    nonce,
    networkId,
    confirmationKey,
    holderKeyCommitment,
    requestCommitment,
    signature
}: {
    nonce: Uint8Array | Hex
    networkId: Uint8Array | Hex
    confirmationKey: Uint8Array | Hex
    holderKeyCommitment: Uint8Array | Hex
    requestCommitment: Uint8Array | Hex
    signature: Uint8Array | Hex
}): boolean {
    const message = buildDeviceBindingMessage(nonce, networkId, holderKeyCommitment, requestCommitment)
    const publicKeyBytes = prependUncompressedPrefix(normalizeConfirmationKey(confirmationKey))
    const parsedSignature = parseDeviceSignature(signature)

    return p256.verify(parsedSignature.toCompactRawBytes(), message, publicKeyBytes, {
        prehash: true,
        lowS: false
    })
}

/**
 * The full issuer gate: one `networkId` derived from `accountPublicKey` gates
 * both `sig_A` and `sig_B`, so a device signature from one session can't pair
 * with an unrelated account signature in either direction. `networkId` is
 * returned even when `valid` is false, for issuer-side logging/rate-limiting.
 */
export function verifyCredentialBinding({
    nonce,
    accountPublicKey,
    confirmationKey,
    holderKeyCommitment,
    requestCommitment,
    accountSignature,
    deviceSignature
}: {
    nonce: Uint8Array | Hex
    accountPublicKey: Uint8Array | Hex
    confirmationKey: Uint8Array | Hex
    holderKeyCommitment: Uint8Array | Hex
    requestCommitment: Uint8Array | Hex
    accountSignature: Uint8Array | Hex
    deviceSignature: Uint8Array | Hex
}): { valid: boolean; networkId: Hex } {
    const publicKeyBytes = normalizeAccountPublicKey(accountPublicKey)
    const networkId = computeNetworkId(publicKeyBytes)

    const accountValid = verifyAccountBindingSignature({
        nonce,
        confirmationKey,
        accountPublicKey: publicKeyBytes,
        signature: accountSignature
    })

    const deviceValid = verifyDeviceBindingSignature({
        nonce,
        networkId,
        confirmationKey,
        holderKeyCommitment,
        requestCommitment,
        signature: deviceSignature
    })

    return { valid: accountValid && deviceValid, networkId }
}
