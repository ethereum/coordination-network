import { afterEach, describe, expect, it, jest } from "@jest/globals"
import { BRANDS } from "@coordination-network/app-ui"
import { brand, branding } from "../src/business/branding"

/** Loads `branding.ts` fresh for the other member - both its name and its colours are decided at
 *  module load, from an env var Metro inlines per build. */
function brandingFor(memberId: string): { displayName: string; accent: string } {
    process.env.EXPO_PUBLIC_MEMBER_ID = memberId
    let loaded!: { branding: { displayName: string }; brand: { accent: string } }
    jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        loaded = require("../src/business/branding")
    })
    return { displayName: loaded.branding.displayName, accent: loaded.brand.accent }
}

describe("branding", () => {
    const originalMemberId = process.env.EXPO_PUBLIC_MEMBER_ID

    afterEach(() => {
        process.env.EXPO_PUBLIC_MEMBER_ID = originalMemberId
    })

    it('names member-a "Member A" and paints it blue', () => {
        expect(branding.displayName).toBe("Member A")
        expect(brand).toEqual(BRANDS.blue)
        expect(brandingFor("member-a")).toEqual({ displayName: "Member A", accent: "#1d4ed8" })
    })

    it('names member-b "Member B" and paints it yellow', () => {
        expect(brandingFor("member-b")).toEqual({ displayName: "Member B", accent: "#f5b400" })
    })
})
