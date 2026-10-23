import { describe, expect, it } from "@jest/globals"
import { nowFn } from "../src/now"

describe("nowFn", () => {
    it("uses the injected clock when one is provided", () => {
        expect(nowFn({ now: () => 42 })).toBe(42)
    })

    it("falls back to Date.now when no clock is injected", () => {
        const before = Date.now()
        const value = nowFn({})
        expect(value).toBeGreaterThanOrEqual(before)
    })
})
