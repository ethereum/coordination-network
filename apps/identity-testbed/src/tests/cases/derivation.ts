import { deriveKeys, generateDeviceSecret } from "@coordination-network/identity"

import { derivationVectors } from "../../vectors"
import { check, errorMessage, finish } from "../result"
import type { Check, TestCase, TestDetail } from "../types"

/**
 * Proves `deriveKeys` runs on this JS engine: re-derives one committed
 * vector's keys plus a fresh device's, reporting `networkId` and timing.
 */
export const derivationCase: TestCase = {
    id: "derivation",
    name: "deriveKeys (vector + fresh secret)",
    description: "Re-derives a committed networkId, then derives a fresh one",
    group: "account",
    tier: "js",
    async run(): Promise<TestDetail> {
        const start = performance.now()

        try {
            const [vector] = derivationVectors.vectors
            const vectorStart = performance.now()
            const vectorKeys = deriveKeys(vector.deviceSecret as `0x${string}`)
            const vectorMs = performance.now() - vectorStart
            const vectorMatch = vectorKeys.networkId === vector.networkId

            const checks: Check[] = [
                check(
                    "committed vector re-derives its networkId",
                    vectorMatch,
                    vectorMatch
                        ? `${vectorKeys.networkId} (${vectorMs.toFixed(2)}ms)`
                        : `expected ${vector.networkId} · got ${vectorKeys.networkId}`
                )
            ]

            if (!vectorMatch) {
                return finish(start, checks)
            }

            const freshSecret = generateDeviceSecret()
            const freshStart = performance.now()
            const freshKeys = deriveKeys(freshSecret)
            const freshMs = performance.now() - freshStart

            checks.push(
                check("fresh secret derives a networkId", true, `${freshKeys.networkId} (${freshMs.toFixed(2)}ms)`)
            )

            return finish(start, checks)
        } catch (error) {
            return finish(start, [check("deriveKeys()", false, errorMessage(error))])
        }
    }
}
