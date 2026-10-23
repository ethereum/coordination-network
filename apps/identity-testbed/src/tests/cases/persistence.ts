import { deriveNetworkId, generateDeviceSecret } from "@coordination-network/identity"

import { DEVICE_SECRET_KEY } from "../../storage-keys"
import type { TestContext } from "../context"
import { check, errorMessage, finish } from "../result"
import type { TestCase, TestDetail } from "../types"

/**
 * Proves the device secret survives an app relaunch via `expo-secure-store`. Only the secret is
 * stored; `networkId` is re-derived on demand and shown so the tester can compare launches.
 */
export const persistenceCase: TestCase = {
    id: "persistence",
    name: "persistence (expo-secure-store)",
    description: "Device secret survives relaunch; networkId is re-derived, not stored",
    group: "account",
    tier: "device",
    async run(ctx: TestContext): Promise<TestDetail> {
        const start = performance.now()

        try {
            const storedSecret = await ctx.secureStore.getItemAsync(DEVICE_SECRET_KEY)

            if (storedSecret === null) {
                const secret = generateDeviceSecret()

                await ctx.secureStore.setItemAsync(DEVICE_SECRET_KEY, secret)

                // Read back to catch a store that silently drops writes.
                const readBack = (await ctx.secureStore.getItemAsync(DEVICE_SECRET_KEY)) === secret

                return finish(start, [
                    check(
                        "first run: device secret stored and read back",
                        readBack,
                        readBack ? deriveNetworkId(secret) : "secure-store write did not read back"
                    )
                ])
            }

            const wellFormed = /^0x[0-9a-f]{64}$/.test(storedSecret)

            return finish(start, [
                check(
                    "device secret survived relaunch",
                    wellFormed,
                    wellFormed ? deriveNetworkId(storedSecret as `0x${string}`) : "stored secret is not 0x + 64 hex"
                )
            ])
        } catch (error) {
            return finish(start, [check("expo-secure-store", false, errorMessage(error))])
        }
    }
}
