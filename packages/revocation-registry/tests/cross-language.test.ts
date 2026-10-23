import { describe, expect, it } from "@jest/globals"
import { RevocationRegistry } from "../src"

/**
 * The other half of the cross-language check. The same constants are asserted on chain in
 * `packages/contracts/test/integration/CrossLanguageRoot.t.sol`.
 *
 * A holder builds their proof against a tree they rebuilt locally, and the verifier checks the
 * resulting root against the contract. If the two implementations drift apart on a hash, a padding
 * rule or an insertion order, every honest proof silently stops verifying, so both sides pin the
 * same numbers.
 */
describe("cross-language roots", () => {
    it("matches the contract for an ascending insertion order", () => {
        expect(new RevocationRegistry([100n, 200n, 300n]).root).toBe(
            6282515766925950962036120222350516575776330851858331345995966968883294491461n
        )
    })

    it("matches the contract for an unsorted insertion order", () => {
        expect(new RevocationRegistry([300n, 100n, 200n, 50n, 900n]).root).toBe(
            16371200927132436184091530429497089969477574266729902012949561363171482853728n
        )
    })

    /**
     * The tombstoned case, which the Solidity side calls out as where the two implementations could
     * most easily drift. It was pinned only on chain until now, so a TypeScript-side regression in
     * tombstone handling would have failed no test here.
     */
    it("matches the contract after a removal", () => {
        const registry = new RevocationRegistry([100n, 200n, 300n])

        registry.unrevoke(200n)

        expect(registry.root).toBe(16715334225205977020523340649771286490583486141052800548644784042059257683463n)
    })
})

describe("cross-language slot tables", () => {
    it("matches the contract for an unsorted insertion order", () => {
        const registry = new RevocationRegistry([300n, 100n, 200n, 50n, 900n])

        expect(registry.leafSlots).toEqual([
            { value: 0n, nextValue: 50n },
            { value: 300n, nextValue: 900n },
            { value: 100n, nextValue: 200n },
            { value: 200n, nextValue: 300n },
            { value: 50n, nextValue: 100n },
            { value: 900n, nextValue: 0n }
        ])
    })

    it("matches the contract after a removal", () => {
        const registry = new RevocationRegistry([100n, 200n, 300n])

        registry.unrevoke(200n)

        expect(registry.leafSlots).toEqual([
            { value: 0n, nextValue: 100n },
            { value: 100n, nextValue: 300n },
            { value: 0n, nextValue: 0n },
            { value: 300n, nextValue: 0n }
        ])

        // The tombstoned slot is still there: the leaf count did not shrink with the removal.
        expect(registry.leafSlots).toHaveLength(4)
        expect(registry.size).toBe(2)
    })
})
