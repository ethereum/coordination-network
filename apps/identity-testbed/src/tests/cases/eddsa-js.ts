import { p256 } from "@noble/curves/p256"
import { hexToBytes, bytesToHex } from "@noble/hashes/utils"
import { deriveEddsaKeypair, EDDSA_PEER_POINT_HEX, eddsaPeerPointBytes, type Hex } from "@coordination-network/identity"

import { eddsaVectors } from "../../vectors"
import { check, errorMessage, finish } from "../result"
import type { Check, TestCase, TestDetail } from "../types"

function checkField(mismatches: string[], label: string, expected: unknown, actual: unknown): void {
    if (expected !== actual) {
        mismatches.push(`${label}: expected ${String(expected)}, got ${String(actual)}`)
    }
}

/** Decodes a `0x`-prefixed hex string; noble's own `hexToBytes` doesn't strip the prefix. */
function hexToBytesLocal(hex: Hex): Uint8Array {
    return hexToBytes(hex.slice(2))
}

/**
 * Portable JS conformance check: replays the committed vectors through
 * `deriveEddsaKeypair` and asserts determinism. Its ECDH leg is a software
 * P-256 stand-in, NOT the real-device path — on device the shared secret comes
 * from the hardware Keystore (`eddsa-keystore`, native `ecdh(alias, Q)`).
 */
export const eddsaJsCase: TestCase = {
    id: "eddsa-js",
    name: "EdDSA key (software P-256 stand-in)",
    description: "Replays EdDSA vectors through deriveEddsaKeypair; determinism",
    group: "eddsa",
    tier: "js",
    async run(): Promise<TestDetail> {
        const start = performance.now()

        try {
            const mismatches: string[] = []

            for (const [i, vector] of eddsaVectors.vectors.entries()) {
                const keys = deriveEddsaKeypair(vector.ecdhSharedSecret as Hex)
                const label = (field: string) => `eddsa[${i}].${field}`

                // ECDH leg on Hermes: hwPriv * Q reproduces the pinned shared secret.
                const ecdhSharedSecret = `0x${bytesToHex(
                    p256
                        .getSharedSecret(hexToBytesLocal(vector.hardwarePrivateKey as Hex), eddsaPeerPointBytes(), true)
                        .slice(1)
                )}`
                checkField(mismatches, label("ecdhSharedSecret"), vector.ecdhSharedSecret, ecdhSharedSecret)

                checkField(mismatches, label("seed"), vector.seed, keys.seed)
                checkField(mismatches, label("secretScalar"), vector.secretScalar, String(keys.secretScalar))
                checkField(mismatches, label("publicKey[0]"), vector.publicKey[0], String(keys.publicKey[0]))
                checkField(mismatches, label("publicKey[1]"), vector.publicKey[1], String(keys.publicKey[1]))
                checkField(mismatches, label("commitment"), vector.commitment, String(keys.commitment))
            }

            const vectorsOk = mismatches.length === 0
            const checks: Check[] = [
                check(
                    `${eddsaVectors.vectors.length} EdDSA vectors re-derive`,
                    vectorsOk,
                    vectorsOk
                        ? "ecdhSharedSecret · seed · secretScalar · publicKey[x,y] · commitment"
                        : `${mismatches.length} mismatch(es), first: ${mismatches[0]}`
                )
            ]

            const note = `peerPoint ${EDDSA_PEER_POINT_HEX}`

            if (!vectorsOk) {
                return finish(start, checks, note)
            }

            // Software stand-in for the hardware ECDH leg: fresh P-256 secret against Q.
            const freshSecret = p256.getSharedSecret(p256.utils.randomSecretKey(), eddsaPeerPointBytes(), true).slice(1)

            const firstStart = performance.now()
            const first = deriveEddsaKeypair(freshSecret)
            const firstMs = performance.now() - firstStart

            const secondStart = performance.now()
            const second = deriveEddsaKeypair(freshSecret)
            const secondMs = performance.now() - secondStart

            const deterministic = first.commitment === second.commitment
            checks.push(
                check(
                    "fresh keypair is deterministic",
                    deterministic,
                    deterministic
                        ? `commitment ${String(first.commitment)} (${firstMs.toFixed(2)}ms, ${secondMs.toFixed(2)}ms)`
                        : `${String(first.commitment)} vs ${String(second.commitment)}`
                )
            )

            return finish(start, checks, note)
        } catch (error) {
            return finish(start, [check("deriveEddsaKeypair()", false, errorMessage(error))])
        }
    }
}
