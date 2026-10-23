import { p256 } from "@noble/curves/p256"
import { deriveEddsaKeypair, EDDSA_PEER_POINT_HEX, eddsaPeerPointBytes } from "@coordination-network/identity"

import {
    base64ToBytes,
    bytesToBase64,
    KEYSTORE_ERROR_CODES,
    keystoreErrorCode
} from "@coordination-network/expo-identity-keystore"
import type { TestContext } from "../context"
import { check, errorMessage, finish } from "../result"
import type { Check, TestCase, TestDetail } from "../types"

/** Alias this case's Keystore key lives under; deleted at the start of each run for a clean slate. */
const KEYSTORE_ALIAS = "testbed-eddsa"

const PROMPT = { title: "Testbed: unlock the agreement key" }

/**
 * Hardware-rooted EdDSA key: a Keystore `agree` key (`PURPOSE_AGREE_KEY` only)
 * does native ECDH against the pinned peer point `Q`, feeding
 * `deriveEddsaKeypair`. The key is separate from the signing key, and signing
 * with it must be refused. ECDH shows a prompt only when the key's 10 s unlock
 * window has lapsed.
 */
export const eddsaKeystoreCase: TestCase = {
    id: "eddsa-keystore",
    name: "EdDSA key (hardware Keystore ECDH)",
    description: "Hardware ECDH feeds the Baby Jubjub key; determinism, and the agreement key refuses to sign",
    group: "eddsa",
    tier: "keystore",
    async run(ctx: TestContext): Promise<TestDetail> {
        const start = performance.now()
        const checks: Check[] = []
        const note = `Q ${EDDSA_PEER_POINT_HEX}`

        const { keystore } = ctx

        if (!keystore) {
            return finish(start, [check("Keystore module available", false, "requires dev build")])
        }

        try {
            await keystore.deleteKey(KEYSTORE_ALIAS)

            const { publicKey: hwPublicKeyBase64 } = await keystore.generateKey(KEYSTORE_ALIAS, { purpose: "agree" })
            const hwPublicKey = base64ToBytes(hwPublicKeyBase64)

            // Android falls back to a software-backed key without StrongBox/TEE
            const securityLevel = await keystore.getSecurityLevel(KEYSTORE_ALIAS)
            const hardwareBacked = securityLevel === "STRONGBOX" || securityLevel === "TRUSTED_ENVIRONMENT"
            checks.push(check("key is hardware-backed", hardwareBacked, `securityLevel ${securityLevel}`))

            if (!hardwareBacked) {
                return finish(start, checks, note)
            }

            // Native-ECDH oracle
            const oraclePrivateKey = p256.utils.randomSecretKey()
            const oraclePublicKey = p256.getPublicKey(oraclePrivateKey, false)
            const oracleSharedSecretBase64 = await keystore.ecdh(KEYSTORE_ALIAS, bytesToBase64(oraclePublicKey), PROMPT)
            const expectedOracleSharedSecret = p256.getSharedSecret(oraclePrivateKey, hwPublicKey, true).slice(1)
            const oracleOk = oracleSharedSecretBase64 === bytesToBase64(expectedOracleSharedSecret)
            checks.push(
                check(
                    "native ECDH matches software r·hwPublicKey",
                    oracleOk,
                    oracleOk ? undefined : "ecdh(alias, R) != r·hwPublicKey"
                )
            )

            if (!oracleOk) {
                return finish(start, checks, note)
            }

            const qBase64 = bytesToBase64(eddsaPeerPointBytes())
            const ss1Base64 = await keystore.ecdh(KEYSTORE_ALIAS, qBase64, PROMPT)
            const ss2Base64 = await keystore.ecdh(KEYSTORE_ALIAS, qBase64, PROMPT)
            const sharedSecret = base64ToBytes(ss1Base64)
            const ecdhOk = ss1Base64 === ss2Base64 && sharedSecret.length === 32
            checks.push(
                check(
                    "ecdh(alias, Q) is deterministic and 32 bytes",
                    ecdhOk,
                    ecdhOk ? undefined : `deterministic=${ss1Base64 === ss2Base64}, length=${sharedSecret.length}`
                )
            )

            if (!ecdhOk) {
                return finish(start, checks, note)
            }

            const firstStart = performance.now()
            const first = deriveEddsaKeypair(sharedSecret)
            const firstMs = performance.now() - firstStart

            const secondStart = performance.now()
            const second = deriveEddsaKeypair(sharedSecret)
            const secondMs = performance.now() - secondStart

            const commitmentOk = first.commitment === second.commitment
            checks.push(
                check(
                    "Baby Jubjub commitment is deterministic",
                    commitmentOk,
                    commitmentOk
                        ? `commitment ${String(first.commitment)} (${firstMs.toFixed(2)}ms, ${secondMs.toFixed(2)}ms)`
                        : `${String(first.commitment)} vs ${String(second.commitment)}`
                )
            )

            // The agreement key must not double as a signing key: a signature from it would be
            // a way to make the user-present policy of the signing key irrelevant.
            try {
                const message = p256.utils.randomSecretKey()
                await keystore.sign(KEYSTORE_ALIAS, bytesToBase64(message), PROMPT)
                checks.push(
                    check("sign on the agreement key is refused", false, "expected a rejection, got a signature")
                )
            } catch (error) {
                // A cancel or a failed prompt would pass a test that never reached the key.
                const code = keystoreErrorCode(error)
                checks.push(
                    check(
                        "sign on the agreement key is refused",
                        code !== KEYSTORE_ERROR_CODES.userCanceled &&
                            code !== KEYSTORE_ERROR_CODES.authenticationFailed,
                        `rejected: ${code ?? errorMessage(error)}`
                    )
                )
            }

            // Negative probes: malformed peer points must be rejected by the native
            // decoder, never silently accepted or resolved to a 32-byte secret.
            const flippedXPeerPoint = eddsaPeerPointBytes()
            flippedXPeerPoint[1] ^= 0xff

            const noPrefixPeerPoint = eddsaPeerPointBytes().slice(1)

            const compressedPeerPoint = new Uint8Array(33)
            compressedPeerPoint[0] = 0x02
            compressedPeerPoint.set(eddsaPeerPointBytes().slice(1, 33), 1)

            const probes = [
                { point: flippedXPeerPoint, label: "rejects Q with one X byte flipped" },
                { point: noPrefixPeerPoint, label: "rejects 64-byte point with no 0x04 prefix" },
                { point: compressedPeerPoint, label: "rejects 33-byte compressed point" }
            ]

            for (const { point, label } of probes) {
                try {
                    const result = await keystore.ecdh(KEYSTORE_ALIAS, bytesToBase64(point), PROMPT)
                    checks.push(check(label, false, `expected rejection, got ${result}`))
                } catch (error) {
                    checks.push(check(label, true, `rejected: ${errorMessage(error)}`))
                }
            }

            return finish(start, checks, note)
        } catch (error) {
            // Below Android 12, generateKey rejects with ERR_UNSUPPORTED_PLATFORM.
            return finish(start, [...checks, check("keystore operation", false, errorMessage(error))], note)
        }
    }
}
