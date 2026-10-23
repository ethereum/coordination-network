/** SDK-free sanity check: every registered case is well-formed and unique. */

import { describe, expect, it } from "@jest/globals"

import { allCases } from "../index"

const TIERS = ["js", "device", "keystore"] as const

describe("test-case registry", () => {
    it("contains only well-formed cases", () => {
        for (const testCase of allCases) {
            expect(typeof testCase.id).toBe("string")
            expect(testCase.id.length).toBeGreaterThan(0)
            expect(typeof testCase.name).toBe("string")
            expect(testCase.name.length).toBeGreaterThan(0)
            expect(TIERS).toContain(testCase.tier)
            expect(typeof testCase.run).toBe("function")
        }
    })

    it("registers key-attestation in the device-key group, right after binding-keystore", () => {
        const ids = allCases.map((testCase) => testCase.id)
        const attestation = allCases[ids.indexOf("key-attestation")]

        expect(ids.indexOf("key-attestation")).toBe(ids.indexOf("binding-keystore") + 1)
        expect(attestation).toMatchObject({ group: "device-key", tier: "keystore" })
    })

    it("has no duplicate case ids", () => {
        const ids = allCases.map((testCase) => testCase.id)

        expect(new Set(ids).size).toBe(ids.length)
    })
})
