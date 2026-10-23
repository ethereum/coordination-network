import { describe, expect, it } from "@jest/globals"

import { governanceThreshold } from "../src"

describe("governanceThreshold", () => {
    it("requires a majority: one more than half", () => {
        // The table the runbook publishes, and the same expression the contracts apply on chain. Two
        // members, the smallest set governance will shrink to, means both must sign.
        expect([2, 3, 4, 5, 6, 7, 8, 9, 10].map(governanceThreshold)).toEqual([2, 2, 3, 3, 4, 4, 5, 5, 6])
    })

    it("never lets a single key be enough above one member", () => {
        for (let members = 2; members <= 50; ++members) {
            const threshold = governanceThreshold(members)

            expect(threshold).toBeGreaterThan(members / 2)
            expect(threshold).toBeGreaterThanOrEqual(2)
            expect(threshold).toBeLessThanOrEqual(members)
        }
    })

    it("refuses a nonsensical member count", () => {
        expect(() => governanceThreshold(0)).toThrow("positive integer")
        expect(() => governanceThreshold(-1)).toThrow("positive integer")
        expect(() => governanceThreshold(2.5)).toThrow("positive integer")
    })
})
