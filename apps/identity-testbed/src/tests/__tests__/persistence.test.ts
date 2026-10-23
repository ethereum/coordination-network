import { deriveNetworkId } from "@coordination-network/identity"

import { DEVICE_SECRET_KEY } from "../../storage-keys"
import { persistenceCase } from "../cases/persistence"
import type { TestContext } from "../context"

function fakeContext(items: Map<string, string>): TestContext {
    const secureStore: Pick<TestContext["secureStore"], "getItemAsync" | "setItemAsync" | "deleteItemAsync"> = {
        getItemAsync: async (key) => items.get(key) ?? null,
        setItemAsync: async (key, value) => {
            items.set(key, value)
        },
        deleteItemAsync: async (key) => {
            items.delete(key)
        }
    }

    return { keystore: null, secureStore: secureStore as TestContext["secureStore"] }
}

describe("persistence case", () => {
    it("stores only the device secret on first run and shows its re-derived networkId", async () => {
        const items = new Map<string, string>()

        const detail = await persistenceCase.run(fakeContext(items))

        expect(detail.ok).toBe(true)
        expect(Array.from(items.keys())).toEqual([DEVICE_SECRET_KEY])
        const secret = items.get(DEVICE_SECRET_KEY) as `0x${string}`
        expect(detail.checks[0].detail).toBe(deriveNetworkId(secret))
    })

    it("re-derives the same networkId on a second run without storing anything else", async () => {
        const items = new Map<string, string>()
        const ctx = fakeContext(items)

        const first = await persistenceCase.run(ctx)
        const second = await persistenceCase.run(ctx)

        expect(second.ok).toBe(true)
        expect(second.checks[0].detail).toBe(first.checks[0].detail)
        expect(items.size).toBe(1)
    })

    it("fails when the stored value is not 0x + 64 hex", async () => {
        const items = new Map([[DEVICE_SECRET_KEY, "0x1234"]])

        const detail = await persistenceCase.run(fakeContext(items))

        expect(detail.ok).toBe(false)
    })
})
