import { p256 } from "@noble/curves/p256"
import { base64ToBytes, bytesToBase64, SoftwareKeystore } from "@coordination-network/expo-identity-keystore"

import { check, errorMessage, finish } from "../result"
import type { Check, TestCase, TestDetail } from "../types"

/** Alias this case's Keystore key lives under. */
const KEYSTORE_ALIAS = "testbed-sign-digest-software"

const PROMPT = { title: "Testbed: sign a digest" }

/** `sign-digest`'s flow with the software P-256 stand-in, so it runs under jest. */
export const signDigestSoftwareCase: TestCase = {
    id: "sign-digest-software",
    name: "raw digest signing (software P-256 stand-in)",
    description: "signDigest signs an already-hashed 32-byte digest; rejects a 31-byte one",
    group: "device-key",
    tier: "js",
    async run(): Promise<TestDetail> {
        const start = performance.now()
        const checks: Check[] = []

        try {
            const keystore = new SoftwareKeystore()
            const generated = await keystore.generateKey(KEYSTORE_ALIAS, { purpose: "sign" })
            const publicKey = base64ToBytes(generated.publicKey)
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

            return finish(start, checks)
        } catch (error) {
            return finish(start, [...checks, check("keystore operation", false, errorMessage(error))])
        }
    }
}
