import { p256 } from "@noble/curves/p256"
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
const KEYSTORE_ALIAS = "testbed-sign-digest"

const PROMPT = { title: "Testbed: sign a digest" }
const CANCEL_PROMPT = { title: "Testbed: CANCEL this prompt" }

/**
 * `signDigest` signs an already-computed digest directly (`NONEwithECDSA`),
 * unlike `sign`'s internal SHA-256 — the mode a caller building its own
 * message digest (e.g. a JWS signing input) needs. The key needs the user
 * present on every signature, so the case prompts; its last step asks the
 * tester to cancel, to check the cancel code.
 */
export const signDigestCase: TestCase = {
    id: "sign-digest",
    name: "raw digest signing (hardware Keystore)",
    description: "signDigest signs an already-hashed 32-byte digest; rejects a 31-byte one",
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

            const { publicKey: generatedKeyBase64 } = await keystore.generateKey(KEYSTORE_ALIAS, { purpose: "sign" })
            checks.push(
                check("hasKey reports the alias exists after generateKey", await keystore.hasKey(KEYSTORE_ALIAS))
            )

            const readBackKeyBase64 = await keystore.getPublicKey(KEYSTORE_ALIAS)
            checks.push(
                check(
                    "getPublicKey returns the same key generateKey returned",
                    readBackKeyBase64 === generatedKeyBase64,
                    readBackKeyBase64 === generatedKeyBase64 ? undefined : "getPublicKey returned a different key"
                )
            )

            const publicKey = base64ToBytes(readBackKeyBase64)

            const securityLevel = await keystore.getSecurityLevel(KEYSTORE_ALIAS)
            const hardwareBacked = securityLevel === "STRONGBOX" || securityLevel === "TRUSTED_ENVIRONMENT"
            checks.push(check("key is hardware-backed", hardwareBacked, `securityLevel ${securityLevel}`))

            if (!hardwareBacked) {
                return finish(start, checks)
            }

            const digest = p256.utils.randomSecretKey() // any 32 random bytes
            const signatureDer = base64ToBytes(await keystore.signDigest(KEYSTORE_ALIAS, bytesToBase64(digest), PROMPT))
            const signatureValid = p256.verify(signatureDer, digest, publicKey, { prehash: false, lowS: false })
            checks.push(
                check(
                    "signDigest signature verifies over the raw digest",
                    signatureValid,
                    signatureValid ? undefined : "p256.verify rejected it"
                )
            )

            try {
                await keystore.signDigest(KEYSTORE_ALIAS, bytesToBase64(new Uint8Array(31)), PROMPT)
                checks.push(check("31-byte digest is rejected", false, "expected a rejection, got a signature"))
            } catch (error) {
                checks.push(check("31-byte digest is rejected", true, errorMessage(error)))
            }

            // Manual step: the framework cannot press Cancel, so the tester must. Authenticating
            // instead fails this check, which is the point of it.
            try {
                await keystore.signDigest(KEYSTORE_ALIAS, bytesToBase64(digest), CANCEL_PROMPT)
                checks.push(
                    check("MANUAL: cancelled prompt reports ERR_USER_CANCELED", false, "prompt was not cancelled")
                )
            } catch (error) {
                const code = keystoreErrorCode(error)
                checks.push(
                    check(
                        "MANUAL: cancelled prompt reports ERR_USER_CANCELED",
                        code === KEYSTORE_ERROR_CODES.userCanceled,
                        `got ${code ?? errorMessage(error)}`
                    )
                )
            }

            return finish(start, checks)
        } catch (error) {
            return finish(start, [...checks, check("keystore operation", false, errorMessage(error))])
        }
    }
}
