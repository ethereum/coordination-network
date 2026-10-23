import {
    BINDING_NONCE_LENGTH,
    buildAccountBindingMessage,
    buildDeviceBindingMessage,
    computeConfirmationKeyHash,
    computeNetworkId,
    deriveAccountKeypair,
    deriveKeys,
    signAccountBinding,
    signDerivationMessage,
    verifyAccountBindingSignature,
    verifyCredentialBinding,
    verifyDeviceBindingSignature,
    type Hex
} from "@coordination-network/identity"
import { keccak_256 } from "@noble/hashes/sha3"

import { bindingVectors, derivationVectors } from "../../vectors"
import { check, errorMessage, finish } from "../result"
import type { TestCase, TestDetail } from "../types"

function checkField(mismatches: string[], label: string, expected: unknown, actual: unknown): void {
    if (expected !== actual) {
        mismatches.push(`${label}: expected ${String(expected)}, got ${String(actual)}`)
    }
}

/** Hex-encodes without Node's `Buffer` (unavailable under Hermes). */
function bytesToHexLocal(bytes: Uint8Array): Hex {
    let hex = ""

    for (const byte of bytes) {
        hex += byte.toString(16).padStart(2, "0")
    }

    return `0x${hex}`
}

/** Rebuilds the EIP-191 digest exactly as `signAccountBinding` does (`DERIVATION.md` §11.3). */
function eip191Digest(message: Uint8Array): Uint8Array {
    const prefix = new TextEncoder().encode(`\x19Ethereum Signed Message:\n${String(message.length)}`)
    const preimage = new Uint8Array(prefix.length + message.length)

    preimage.set(prefix, 0)
    preimage.set(message, prefix.length)

    return keccak_256(preimage)
}

function replayDerivationVectors(mismatches: string[]): void {
    for (const [i, vector] of derivationVectors.vectors.entries()) {
        const keys = deriveKeys(vector.deviceSecret as Hex)
        const label = (field: string) => `derivation[${i}].${field}`

        checkField(mismatches, label("version"), vector.version, keys.version)
        checkField(mismatches, label("networkId"), vector.networkId, keys.networkId)

        // `v` is covered transitively by the spending/viewing/auth key checks.
        const compact = signDerivationMessage(keys.account.privateKey)
        checkField(mismatches, label("signature.compact"), vector.signature.compact, compact)
        checkField(mismatches, label("signature.r"), vector.signature.r, compact.slice(0, 66))
        checkField(mismatches, label("signature.s"), vector.signature.s, `0x${compact.slice(66)}`)

        for (const role of ["account", "spending", "viewing", "auth"] as const) {
            const expected = vector[role]
            const actual = keys[role]

            checkField(mismatches, label(`${role}.privateKey`), expected.privateKey, actual.privateKey)
            checkField(mismatches, label(`${role}.publicKey`), expected.publicKey, actual.publicKey)
            checkField(
                mismatches,
                label(`${role}.uncompressedPublicKey`),
                expected.uncompressedPublicKey,
                actual.uncompressedPublicKey
            )
        }
    }
}

function replayBindingScheme(mismatches: string[]): void {
    const { scheme } = bindingVectors

    checkField(mismatches, "binding.scheme.bindingNonceLength", scheme.bindingNonceLength, BINDING_NONCE_LENGTH)
    checkField(mismatches, "binding.scheme.confirmationKeyHash", scheme.confirmationKeyHash, "RFC7638-JWK-thumbprint")
    checkField(mismatches, "binding.scheme.sigA", scheme.sigA, "EIP-191 + RFC6979 lowS secp256k1 compact")
    checkField(mismatches, "binding.scheme.sigB", scheme.sigB, "ECDSA-P256-SHA256")
}

/** Replays the binding vectors: field re-derivations go to `fields`, the verify gates to `gates`. */
function replayBindingVectors(fields: string[], gates: string[]): void {
    for (const [i, vector] of bindingVectors.vectors.entries()) {
        const label = (field: string) => `binding[${i}].${field}`
        const account = deriveAccountKeypair(vector.deviceSecret as Hex)
        const networkId = computeNetworkId(account.uncompressedPublicKey)

        checkField(fields, label("networkId"), vector.networkId, networkId)
        checkField(
            fields,
            label("confirmationKeyHash"),
            vector.confirmationKeyHash,
            computeConfirmationKeyHash(vector.confirmationKey as Hex)
        )

        const deviceBindingMessage = buildDeviceBindingMessage(
            vector.nonce as Hex,
            networkId,
            vector.holderKeyCommitment as Hex,
            vector.requestCommitment as Hex
        )
        checkField(
            fields,
            label("deviceBindingMessage"),
            vector.deviceBindingMessage,
            bytesToHexLocal(deviceBindingMessage)
        )

        const accountBindingMessage = buildAccountBindingMessage(
            vector.nonce as Hex,
            vector.confirmationKey as Hex,
            networkId
        )
        checkField(
            fields,
            label("accountBindingMessage"),
            vector.accountBindingMessage,
            bytesToHexLocal(accountBindingMessage)
        )
        checkField(
            fields,
            label("accountDigest"),
            vector.accountDigest,
            bytesToHexLocal(eip191Digest(accountBindingMessage))
        )

        // Re-signed sig_A must match the committed vector byte-for-byte (RFC-6979 determinism).
        const resigned = signAccountBinding(account.privateKey, vector.nonce as Hex, vector.confirmationKey as Hex)
        checkField(fields, label("sigA"), vector.sigA, resigned.signature)
        checkField(fields, label("sigA.networkId"), vector.networkId, resigned.networkId)

        checkField(
            gates,
            label("verifyAccountBindingSignature(sigA)"),
            true,
            verifyAccountBindingSignature({
                nonce: vector.nonce as Hex,
                confirmationKey: vector.confirmationKey as Hex,
                accountPublicKey: account.uncompressedPublicKey,
                signature: vector.sigA as Hex
            })
        )

        checkField(
            gates,
            label("verifyDeviceBindingSignature(sigB)"),
            true,
            verifyDeviceBindingSignature({
                nonce: vector.nonce as Hex,
                networkId,
                confirmationKey: vector.confirmationKey as Hex,
                holderKeyCommitment: vector.holderKeyCommitment as Hex,
                requestCommitment: vector.requestCommitment as Hex,
                signature: vector.sigB as Hex
            })
        )

        // Issuer gate: the committed sig_B must verify against the re-derived networkId and re-signed sig_A.
        const { valid } = verifyCredentialBinding({
            nonce: vector.nonce as Hex,
            accountPublicKey: account.uncompressedPublicKey,
            confirmationKey: vector.confirmationKey as Hex,
            holderKeyCommitment: vector.holderKeyCommitment as Hex,
            requestCommitment: vector.requestCommitment as Hex,
            accountSignature: resigned.signature,
            deviceSignature: vector.sigB as Hex
        })
        checkField(gates, label("verifyCredentialBinding"), true, valid)
    }
}

/**
 * Replays both committed vector files field-by-field (including re-signing
 * `sig_A`) — proves this JS engine's math matches the Node engine that
 * generated the vectors.
 */
export const vectorsKatCase: TestCase = {
    id: "vectors-kat",
    name: "KAT vectors (derivation + binding)",
    description: "Replays committed derivation + binding vectors and the verify gates",
    group: "issuer",
    tier: "js",
    async run(): Promise<TestDetail> {
        const start = performance.now()

        try {
            const derivation: string[] = []
            const scheme: string[] = []
            const bindingFields: string[] = []
            const gates: string[] = []

            replayDerivationVectors(derivation)
            replayBindingScheme(scheme)
            replayBindingVectors(bindingFields, gates)

            const summary = (mismatches: string[], fields: string) =>
                mismatches.length === 0 ? fields : `${mismatches.length} mismatch(es), first: ${mismatches[0]}`

            return finish(start, [
                check(
                    `${derivationVectors.vectors.length} derivation vectors replay`,
                    derivation.length === 0,
                    summary(derivation, "version · networkId · sig r/s · account/spending/viewing/auth keys")
                ),
                check(
                    "binding scheme constants match",
                    scheme.length === 0,
                    summary(scheme, "nonce length · confirmationKeyHash · sig_A · sig_B")
                ),
                check(
                    `${bindingVectors.vectors.length} binding vectors replay`,
                    bindingFields.length === 0,
                    summary(bindingFields, "networkId · confirmationKeyHash · messages · EIP-191 digest · sig_A")
                ),
                check(
                    "issuer gates verify (sig_A, sig_B, credential binding)",
                    gates.length === 0,
                    summary(
                        gates,
                        "verifyAccountBindingSignature · verifyDeviceBindingSignature · verifyCredentialBinding"
                    )
                )
            ])
        } catch (error) {
            return finish(start, [check("KAT replay", false, errorMessage(error))])
        }
    }
}
