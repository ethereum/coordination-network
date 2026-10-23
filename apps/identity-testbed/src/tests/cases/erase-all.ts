import { eraseAll } from "../../erase"
import { DEVICE_SECRET_KEY } from "../../storage-keys"
import type { TestContext } from "../context"
import { check, errorMessage, finish } from "../result"
import type { Check, TestCase, TestDetail } from "../types"

/** Alias this case's sentinel Keystore key lives under. */
const KEYSTORE_ALIAS = "testbed-erase"

/**
 * Proves `eraseAll` wipes both stores: a sentinel Keystore key and a sentinel
 * SecureStore value are seeded, then `eraseAll` must remove both.
 * Deletion is backing-independent, so this case does not gate on hardware security level.
 */
export const eraseAllCase: TestCase = {
    id: "erase-all",
    name: "eraseAll (Keystore + SecureStore)",
    description: "Wipes every Keystore alias and SecureStore key; both stores read back empty",
    group: "account",
    tier: "keystore",
    async run(ctx: TestContext): Promise<TestDetail> {
        const start = performance.now()
        const checks: Check[] = []

        const { keystore, secureStore } = ctx

        if (!keystore) {
            return finish(start, [check("Keystore module available", false, "requires dev build")])
        }

        try {
            await keystore.generateKey(KEYSTORE_ALIAS, { purpose: "sign" })
            await secureStore.setItemAsync(DEVICE_SECRET_KEY, "sentinel-secret")

            const deletedCount = await eraseAll(keystore, secureStore)
            checks.push(check("deleted count >= 1", deletedCount >= 1, `deleted ${deletedCount}`))

            try {
                await keystore.getSecurityLevel(KEYSTORE_ALIAS)
                checks.push(check("sentinel Keystore key is gone", false, "getSecurityLevel resolved, expected reject"))
            } catch (error) {
                checks.push(check("sentinel Keystore key is gone", true, errorMessage(error)))
            }

            const remainingSecret = await secureStore.getItemAsync(DEVICE_SECRET_KEY)
            const secureStoreCleared = remainingSecret === null
            checks.push(
                check(
                    "SecureStore keys read back null",
                    secureStoreCleared,
                    secureStoreCleared ? undefined : `secret=${remainingSecret}`
                )
            )

            return finish(start, checks)
        } catch (error) {
            return finish(start, [...checks, check("erase-all operation", false, errorMessage(error))])
        }
    }
}
