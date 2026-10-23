import { allCases } from "../index"
import type { TestContext } from "../context"

// js-tier cases never touch ctx — a stub context runs under plain jest.
const ctx: TestContext = { keystore: null, secureStore: {} as TestContext["secureStore"] }

const jsCases = allCases.filter((testCase) => testCase.tier === "js")

describe("js-tier test cases", () => {
    it("has at least one js-tier case registered", () => {
        expect(jsCases.length).toBeGreaterThan(0)
    })

    it.each(jsCases.map((testCase) => [testCase.id, testCase] as const))("%s", async (_id, testCase) => {
        const detail = await testCase.run(ctx)

        if (!detail.ok) {
            const failures = detail.checks
                .filter((entry) => !entry.ok)
                .map((entry) => `${entry.label}: ${entry.detail ?? "failed"}`)
            console.error(failures.join("\n"))
        }

        expect(detail.ok).toBe(true)
    })
})
