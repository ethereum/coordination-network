import { generateDeviceSecret, KeygenError } from "@coordination-network/identity"

import { check, errorMessage, finish } from "../result"
import type { TestCase, TestDetail } from "../types"

const DEVICE_SECRET_HEX_LENGTH = 2 + 64 // "0x" + 32 bytes

/**
 * Proves the polyfilled `crypto.getRandomValues` is wired up on this runtime:
 * `generateDeviceSecret()` must produce two distinct 32-byte secrets.
 */
export const rngCase: TestCase = {
    id: "rng",
    name: "device RNG (react-native-get-random-values)",
    description: "Polyfilled CSPRNG yields distinct 32-byte device secrets",
    group: "account",
    tier: "device",
    async run(): Promise<TestDetail> {
        const start = performance.now()

        try {
            if (typeof globalThis.crypto?.getRandomValues !== "function") {
                return finish(start, [
                    check(
                        "crypto.getRandomValues is polyfilled",
                        false,
                        "missing — is react-native-get-random-values imported first?"
                    )
                ])
            }

            const first = generateDeviceSecret()
            const second = generateDeviceSecret()

            const correctLength =
                first.length === DEVICE_SECRET_HEX_LENGTH && second.length === DEVICE_SECRET_HEX_LENGTH
            const distinct = first !== second

            return finish(start, [
                check("crypto.getRandomValues is polyfilled", true),
                check(
                    "secrets are 32-byte hex",
                    correctLength,
                    correctLength ? undefined : `expected ${DEVICE_SECRET_HEX_LENGTH}-char hex`
                ),
                check(
                    "two calls produce distinct secrets",
                    distinct,
                    distinct ? undefined : "RNG returned the same secret twice"
                )
            ])
        } catch (error) {
            const missingPolyfill = error instanceof KeygenError && error.code === "DERIVATION_FAILURE"
            const detail = missingPolyfill
                ? `${errorMessage(error)} — polyfill missing, is react-native-get-random-values imported first?`
                : errorMessage(error)

            return finish(start, [check("generateDeviceSecret()", false, detail)])
        }
    }
}
