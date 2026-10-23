import {
    buildBindingMessages,
    deriveAccountKeypair,
    generateDeviceSecret,
    signAccountBinding,
    verifyCredentialBinding,
    verifyDeviceBindingSignature,
    type Hex
} from "@coordination-network/identity"

import { base64ToBytes, bytesToBase64 } from "@coordination-network/expo-identity-keystore"
import type { TestContext } from "../context"
import { check, errorMessage, finish } from "../result"
import type { Check, TestCase, TestDetail } from "../types"

/** Alias this case's Keystore key lives under; deleted at the start of each run for a clean slate. */
const KEYSTORE_ALIAS = "testbed-confirmation"

const PROMPT = { title: "Testbed: bind a credential" }

/** Flips the first byte of a 32-byte `0x`-prefixed hex value (used for the tamper negative). */
function flipFirstByte(hex: Hex): Hex {
    const body = hex.slice(2)
    const flippedByte = (parseInt(body.slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, "0")

    return `0x${flippedByte}${body.slice(2)}` as Hex
}

/**
 * `binding-software`'s flow with the real thing: the P-256 `confirmationKey`
 * and `sig_B` come from the Android Keystore module (the signing needs the
 * user present, so run it on a device you can unlock), plus a tamper negative.
 */
export const bindingKeystoreCase: TestCase = {
    id: "binding-keystore",
    name: "credential binding (hardware Keystore)",
    description: "Hardware confirmationKey signs sig_B; verifies, and fails closed on tamper",
    group: "device-key",
    tier: "keystore",
    async run(ctx: TestContext): Promise<TestDetail> {
        const start = performance.now()
        const checks: Check[] = []

        const { keystore } = ctx

        if (!keystore) {
            return finish(start, [check("Keystore module available", false, "requires dev build")])
        }

        try {
            await keystore.deleteKey(KEYSTORE_ALIAS)

            await keystore.generateKey(KEYSTORE_ALIAS, { purpose: "sign" })
            checks.push(
                check("hasKey reports the alias exists after generateKey", await keystore.hasKey(KEYSTORE_ALIAS))
            )

            const confirmationKey = base64ToBytes(await keystore.getPublicKey(KEYSTORE_ALIAS))

            // Android falls back to a software-backed key without StrongBox/TEE (e.g. an
            // emulator) — fail closed so this hardware tier stays meaningful.
            const securityLevel = await keystore.getSecurityLevel(KEYSTORE_ALIAS)
            const hardwareBacked = securityLevel === "STRONGBOX" || securityLevel === "TRUSTED_ENVIRONMENT"
            checks.push(check("confirmationKey is hardware-backed", hardwareBacked, `securityLevel ${securityLevel}`))

            if (!hardwareBacked) {
                return finish(start, checks)
            }

            const account = deriveAccountKeypair(generateDeviceSecret())
            const nonce = generateDeviceSecret()
            // Opaque 32-byte stand-ins: the identity package never interprets either commitment.
            const holderKeyCommitment = generateDeviceSecret()
            const requestCommitment = generateDeviceSecret()

            const { networkId, deviceBindingMessage } = buildBindingMessages(
                nonce,
                account.uncompressedPublicKey,
                confirmationKey,
                holderKeyCommitment,
                requestCommitment
            )
            const { signature: accountSignature } = signAccountBinding(account.privateKey, nonce, confirmationKey)
            const deviceSignatureDer = base64ToBytes(
                await keystore.sign(KEYSTORE_ALIAS, bytesToBase64(deviceBindingMessage), PROMPT)
            )

            const deviceSignatureValid = verifyDeviceBindingSignature({
                nonce,
                networkId,
                confirmationKey,
                holderKeyCommitment,
                requestCommitment,
                signature: deviceSignatureDer
            })
            checks.push(
                check(
                    "hardware sig_B verifies",
                    deviceSignatureValid,
                    deviceSignatureValid ? undefined : "verifyDeviceBindingSignature rejected it"
                )
            )

            const bindingResult = verifyCredentialBinding({
                nonce,
                accountPublicKey: account.uncompressedPublicKey,
                confirmationKey,
                holderKeyCommitment,
                requestCommitment,
                accountSignature,
                deviceSignature: deviceSignatureDer
            })
            checks.push(
                check(
                    "credential binding verifies",
                    bindingResult.valid,
                    bindingResult.valid ? `networkId ${bindingResult.networkId}` : "verifyCredentialBinding rejected it"
                )
            )

            // Tamper negative: the original sig_B against a flipped-nonce message must fail closed, not throw.
            const tamperedValid = verifyDeviceBindingSignature({
                nonce: flipFirstByte(nonce),
                networkId,
                confirmationKey,
                holderKeyCommitment,
                requestCommitment,
                signature: deviceSignatureDer
            })
            checks.push(
                check(
                    "tampered nonce is rejected",
                    !tamperedValid,
                    tamperedValid ? "expected valid=false, got true" : undefined
                )
            )

            return finish(start, checks)
        } catch (error) {
            return finish(start, [...checks, check("keystore operation", false, errorMessage(error))])
        }
    }
}
