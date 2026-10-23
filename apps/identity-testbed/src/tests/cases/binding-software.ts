import { p256 } from "@noble/curves/p256"
import {
    buildBindingMessages,
    buildDeviceBindingMessage,
    computeNetworkId,
    deriveAccountKeypair,
    generateDeviceSecret,
    signAccountBinding,
    verifyCredentialBinding,
    type Hex
} from "@coordination-network/identity"

import { check, errorMessage, finish } from "../result"
import type { TestCase, TestDetail } from "../types"

/**
 * Full dual-PoP flow with a software P-256 stand-in for the hardware
 * `confirmationKey`: sign, verify (`sig_B` in compact and DER), and reject a
 * relayed `sig_B` from a different session's `networkId`.
 */
export const bindingSoftwareCase: TestCase = {
    id: "binding-software",
    name: "credential binding (software P-256 stand-in)",
    description: "Signs and verifies sig_B, and rejects a relayed one",
    group: "device-key",
    tier: "js",
    async run(): Promise<TestDetail> {
        const start = performance.now()

        try {
            const account = deriveAccountKeypair(generateDeviceSecret())
            const confirmationPrivateKey = p256.utils.randomSecretKey()
            const confirmationKey = p256.getPublicKey(confirmationPrivateKey, false) // 65B uncompressed
            const nonce = generateDeviceSecret()
            // Opaque 32-byte stand-ins: the identity package never interprets either commitment.
            const holderKeyCommitment = generateDeviceSecret()
            const requestCommitment = generateDeviceSecret()

            const { deviceBindingMessage } = buildBindingMessages(
                nonce,
                account.uncompressedPublicKey,
                confirmationKey,
                holderKeyCommitment,
                requestCommitment
            )

            const { signature: accountSignature } = signAccountBinding(account.privateKey, nonce, confirmationKey)

            const p256Signature = p256.sign(deviceBindingMessage, confirmationPrivateKey, {
                prehash: true,
                lowS: false
            })

            function verifyBinding(deviceSignature: Uint8Array | Hex): { valid: boolean; networkId: Hex } {
                return verifyCredentialBinding({
                    nonce,
                    accountPublicKey: account.uncompressedPublicKey,
                    confirmationKey,
                    holderKeyCommitment,
                    requestCommitment,
                    accountSignature,
                    deviceSignature
                })
            }

            const compactResult = verifyBinding(p256Signature.toCompactRawBytes())
            const derResult = verifyBinding(p256Signature.toDERRawBytes())

            // Relay attack: a sig_B for a different session's networkId must not verify.
            const otherNetworkId = computeNetworkId(deriveAccountKeypair(generateDeviceSecret()).uncompressedPublicKey)
            const relaySignature = p256
                .sign(
                    buildDeviceBindingMessage(nonce, otherNetworkId, holderKeyCommitment, requestCommitment),
                    confirmationPrivateKey,
                    {
                        prehash: true,
                        lowS: false
                    }
                )
                .toCompactRawBytes()
            const relayResult = verifyBinding(relaySignature)

            return finish(start, [
                check(
                    "compact sig_B verifies",
                    compactResult.valid,
                    compactResult.valid ? `networkId ${compactResult.networkId}` : "rejected a valid compact sig_B"
                ),
                check(
                    "DER-wrapped sig_B verifies",
                    derResult.valid,
                    derResult.valid ? undefined : "rejected a valid DER sig_B"
                ),
                check(
                    "relayed sig_B (mismatched networkId) is rejected",
                    !relayResult.valid,
                    relayResult.valid ? "expected rejection, got valid=true" : undefined
                )
            ])
        } catch (error) {
            return finish(start, [check("verifyCredentialBinding", false, errorMessage(error))])
        }
    }
}
