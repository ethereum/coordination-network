import { cleanWalletUrl, resetWallet } from "../src/navigation"

describe("wallet navigation", () => {
    it("removes the completed link request when resetting the wallet", () => {
        expect(cleanWalletUrl("http://localhost:4173/?payload=stale-request#response")).toBe("http://localhost:4173/")
    })

    it("waits for all wallet state to be cleared", async () => {
        const store = { clear: jest.fn(async () => undefined), list: jest.fn(async () => []) }
        await resetWallet(store)
        expect(store.clear).toHaveBeenCalledTimes(1)
        expect(store.list).toHaveBeenCalledTimes(1)
    })

    it("does not claim reset succeeded if data remains", async () => {
        const store = { clear: jest.fn(async () => undefined), list: jest.fn(async () => ["app:identity"]) }
        await expect(resetWallet(store)).rejects.toThrow("Wallet data could not be removed")
    })
})
