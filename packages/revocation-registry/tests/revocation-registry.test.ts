import { describe, expect, it } from "@jest/globals"
import { LeanIMTPlus } from "@zk-kit/lean-imt-plus"
import {
    PROOF_TYPE,
    RevocationRegistry,
    SNAPSHOT_VERSION,
    SNARK_SCALAR_FIELD,
    TAG_LEAF,
    revocationHashes,
    toCommitment,
    toFieldElement
} from "../src"

const A = 100n
const B = 200n
const C = 300n
const D = 400n

/** A registry built from `commitments`, then emptied of `removals`, leaving tombstones behind. */
function withRemovals(commitments: bigint[], removals: bigint[]): RevocationRegistry {
    const registry = new RevocationRegistry(commitments)

    for (const removal of removals) {
        registry.unrevoke(removal)
    }

    return registry
}

/** A registry where a removed commitment was revoked again, so it occupies a fresh slot. */
function reRevoked(): RevocationRegistry {
    const registry = withRemovals([A, B], [A])

    registry.revoke(A)

    return registry
}

/** A registry where a commitment was replaced in place, which reuses its slot. */
function replaced(): RevocationRegistry {
    const registry = new RevocationRegistry([A, B])

    registry.updateCommitment(B, C)

    return registry
}

describe("RevocationRegistry", () => {
    describe("construction", () => {
        it("starts empty with a zero root", () => {
            const tree = new RevocationRegistry()

            expect(tree.root).toBe(0n)
            expect(tree.size).toBe(0)
            expect(tree.depth).toBe(0)
            expect(tree.commitments).toEqual([])
        })

        it("accepts an initial commitment list", () => {
            const tree = new RevocationRegistry([A, B, C])

            expect(tree.size).toBe(3)
            expect(tree.commitments).toEqual([A, B, C])
        })

        it("coerces numbers and decimal strings to field elements", () => {
            const tree = new RevocationRegistry([100, "200"])

            expect(tree.commitments).toEqual([A, B])
        })

        it("builds the same root whether commitments are batched or added one by one", () => {
            const batched = new RevocationRegistry([A, C, B])
            const incremental = new RevocationRegistry()

            incremental.revoke(A)
            incremental.revoke(C)
            incremental.revoke(B)

            expect(batched.root).toBe(incremental.root)
        })

        it("builds a different root for a different insertion order", () => {
            expect(new RevocationRegistry([A, B]).root).not.toBe(new RevocationRegistry([B, A]).root)
        })

        it("agrees with a bare LeanIMT+ built with the same hashes", () => {
            const bare = new LeanIMTPlus(revocationHashes, [A, B, C])

            expect(new RevocationRegistry([A, B, C]).root).toBe(bare.root)
        })

        it("builds a root a caller can reproduce from the exported hashes and tag", () => {
            const registry = new RevocationRegistry([A, B])

            // Leaves are the sentinel plus one per commitment, linked in sorted order.
            const leaf = (value: bigint, nextValue: bigint) => revocationHashes.leaf(value, nextValue, TAG_LEAF)

            // LeanIMT promotes the unpaired third leaf unchanged instead of hashing it with a zero.
            const root = revocationHashes.internal(revocationHashes.internal(leaf(0n, A), leaf(A, B)), leaf(B, 0n))

            expect(registry.root).toBe(root)
        })
    })

    describe("commitment validation", () => {
        it("coerces through the same helper the class uses", () => {
            expect(toCommitment(100)).toBe(A)
            expect(toCommitment("200")).toBe(B)
            expect(toCommitment(SNARK_SCALAR_FIELD - 1n)).toBe(SNARK_SCALAR_FIELD - 1n)
        })

        it("accepts zero as a field element but not as a commitment", () => {
            expect(toFieldElement(0n)).toBe(0n)
            expect(() => toCommitment(0n)).toThrow("greater than zero")
        })

        it("rejects field elements outside the field", () => {
            expect(() => toFieldElement(-1n)).toThrow("must not be negative")
            expect(() => toFieldElement(SNARK_SCALAR_FIELD)).toThrow("SNARK scalar field")
        })

        it("rejects zero, which is reserved for the sentinel and tombstones", () => {
            expect(() => new RevocationRegistry().revoke(0n)).toThrow("greater than zero")
        })

        it("rejects negative values", () => {
            expect(() => new RevocationRegistry().revoke(-1n)).toThrow("greater than zero")
        })

        it("rejects values at or above the SNARK scalar field order", () => {
            expect(() => new RevocationRegistry().revoke(SNARK_SCALAR_FIELD)).toThrow("SNARK scalar field")
        })
    })

    describe("revoke", () => {
        it("marks a credential as revoked and changes the root", () => {
            const tree = new RevocationRegistry([A])
            const rootBefore = tree.root

            tree.revoke(B)

            expect(tree.isRevoked(B)).toBe(true)
            expect(tree.root).not.toBe(rootBefore)
        })

        it("leaves other commitments unrevoked", () => {
            const tree = new RevocationRegistry([A])

            expect(tree.isRevoked(B)).toBe(false)
            expect(tree.indexOf(B)).toBe(-1)
        })

        it("rejects a double revocation", () => {
            const tree = new RevocationRegistry([A])

            expect(() => tree.revoke(A)).toThrow()
        })

        it("revokes many at once with the same result as one by one", () => {
            const batched = new RevocationRegistry()
            const incremental = new RevocationRegistry()

            batched.revokeMany([A, B, C, D])
            for (const commitment of [A, B, C, D]) {
                incremental.revoke(commitment)
            }

            expect(batched.root).toBe(incremental.root)
            expect(batched.size).toBe(4)
        })
    })

    describe("unrevoke and updateCommitment", () => {
        it("un-revokes a commitment", () => {
            const tree = new RevocationRegistry([A, B])

            tree.unrevoke(A)

            expect(tree.isRevoked(A)).toBe(false)
            expect(tree.isRevoked(B)).toBe(true)
            expect(tree.size).toBe(1)
        })

        it("replaces a commitment in place without growing the leaf array", () => {
            const tree = new RevocationRegistry([A, B])
            const index = tree.indexOf(B)

            tree.updateCommitment(B, C)

            expect(tree.isRevoked(B)).toBe(false)
            expect(tree.indexOf(C)).toBe(index)
            expect(tree.size).toBe(2)
        })

        it("exposes the indexed leaves with their sorted successors", () => {
            const tree = new RevocationRegistry([B, A])

            expect(tree.leaves).toEqual([
                { value: B, nextValue: 0n },
                { value: A, nextValue: B }
            ])
        })
    })

    describe("generateProof", () => {
        it("refuses to prove anything against an empty registry", () => {
            expect(() => new RevocationRegistry().generateProof(A)).toThrow("empty registry")
        })

        it("returns a non-membership proof for a credential that is not revoked", () => {
            const tree = new RevocationRegistry([A, C])
            const proof = tree.generateProof(B)

            expect(proof.proofType).toBe(PROOF_TYPE.NON_MEMBERSHIP)
            expect(proof.value).toBe(B)
            expect(proof.leaf.value).toBeLessThan(B)
            expect(proof.root).toBe(tree.root)
            expect(tree.verifyProof(proof)).toBe(true)
        })

        it("returns a membership proof for a revoked credential", () => {
            const tree = new RevocationRegistry([A, C])
            const proof = tree.generateProof(C)

            expect(proof.proofType).toBe(PROOF_TYPE.MEMBERSHIP)
            expect(proof.leaf.value).toBe(C)
            expect(tree.verifyProof(proof)).toBe(true)
        })

        it("proves non-membership below the smallest commitment through the sentinel", () => {
            const tree = new RevocationRegistry([B, C])
            const proof = tree.generateProof(A)

            expect(proof.proofType).toBe(PROOF_TYPE.NON_MEMBERSHIP)
            expect(proof.leaf).toEqual({ value: 0n, nextValue: B })
            expect(proof.leafIndex).toBe(0)
            expect(tree.verifyProof(proof)).toBe(true)
        })

        it("proves non-membership above the largest commitment through the tail", () => {
            const tree = new RevocationRegistry([A, B])
            const proof = tree.generateProof(C)

            expect(proof.leaf).toEqual({ value: B, nextValue: 0n })
            expect(tree.verifyProof(proof)).toBe(true)
        })

        it("stops proving non-membership once the credential is revoked", () => {
            const tree = new RevocationRegistry([A])

            expect(tree.generateProof(B).proofType).toBe(PROOF_TYPE.NON_MEMBERSHIP)

            tree.revoke(B)

            expect(tree.generateProof(B).proofType).toBe(PROOF_TYPE.MEMBERSHIP)
        })
    })

    describe("verifyProof", () => {
        it("accepts a proof against the root it was built for", () => {
            const tree = new RevocationRegistry([A, B, C])

            expect(RevocationRegistry.verifyProof(tree.generateProof(D))).toBe(true)
        })

        it("rejects a proof whose value was tampered with", () => {
            const tree = new RevocationRegistry([A, C])
            const proof = tree.generateProof(B)

            expect(RevocationRegistry.verifyProof({ ...proof, value: C })).toBe(false)
        })

        it("rejects a stale proof against the current tree", () => {
            const tree = new RevocationRegistry([A, C])
            const proof = tree.generateProof(B)

            tree.revoke(D)

            expect(tree.verifyProof(proof)).toBe(false)
            expect(RevocationRegistry.verifyProof(proof)).toBe(true)
        })
    })

    describe("lowLeafIndexOf", () => {
        it("returns the sentinel index for the first revocation", () => {
            expect(new RevocationRegistry().lowLeafIndexOf(A)).toBe(0)
        })

        it("returns the index of the predecessor leaf", () => {
            const tree = new RevocationRegistry([A, C])

            expect(tree.lowLeafIndexOf(B)).toBe(tree.indexOf(A))
        })

        it("returns the sentinel index for a commitment below every revoked one", () => {
            expect(new RevocationRegistry([B, C]).lowLeafIndexOf(A)).toBe(0)
        })

        it("refuses to compute an index for an already revoked commitment", () => {
            expect(() => new RevocationRegistry([A]).lowLeafIndexOf(A)).toThrow("already been revoked")
        })

        it("returns the physical slot, not the compacted Merkle path", () => {
            // Three leaves (sentinel, C, A) is the smallest shape where the two differ:
            // the level below the root has an unpaired node, so the proof records one
            // sibling while the low leaf actually sits in slot 2.
            const registry = new RevocationRegistry([C, A])

            expect(registry.leanIMTPlus.generateProof(B).leafIndex).toBe(1)
            expect(registry.indexOf(A)).toBe(2)
            expect(registry.lowLeafIndexOf(B)).toBe(2)
        })

        it("always points at the largest revoked commitment below the value", () => {
            const registry = new RevocationRegistry()

            for (const commitment of [500n, 50n, 250n, 750n, 125n, 900n, 375n]) {
                for (const probe of [1n, 75n, 175n, 275n, 425n, 625n, 1000n]) {
                    if (registry.root === 0n || registry.isRevoked(probe)) continue

                    const below = [...registry.commitments].filter((c) => c < probe).sort((a, b) => (a < b ? -1 : 1))
                    const expected = below.length === 0 ? 0 : registry.indexOf(below[below.length - 1])

                    expect(registry.lowLeafIndexOf(probe)).toBe(expected)
                }

                registry.revoke(commitment)
            }
        })
    })

    describe("lowLeafIndicesOf", () => {
        it("computes each index against the state after the earlier batch values", () => {
            // Ground truth, not a replay of the same helper: revoking C, A, B into an
            // empty registry puts C in slot 1 and A in slot 2, so B's predecessor A is
            // at slot 2. The Solidity test test_revokeMany_matchesRevokingOneByOne
            // drives the contract with these same indices.
            expect(new RevocationRegistry().lowLeafIndicesOf([C, A, B])).toEqual([0, 0, 2])
        })

        it("matches revoking one by one and asking each time", () => {
            const tree = new RevocationRegistry([A])
            const indices = tree.lowLeafIndicesOf([D, C, B])

            const replay = new RevocationRegistry([A])
            const expected = [D, C, B].map((commitment) => {
                const index = replay.lowLeafIndexOf(commitment)
                replay.revoke(commitment)
                return index
            })

            expect(indices).toEqual(expected)
        })

        it("leaves the tree untouched", () => {
            const tree = new RevocationRegistry([A])
            const root = tree.root

            tree.lowLeafIndicesOf([B, C])

            expect(tree.root).toBe(root)
            expect(tree.size).toBe(1)
        })
    })

    describe("predecessorIndexOf", () => {
        it("returns the index of the leaf pointing at the commitment", () => {
            const tree = new RevocationRegistry([A, B])

            expect(tree.predecessorIndexOf(B)).toBe(tree.indexOf(A))
        })

        it("returns the sentinel index for the smallest commitment", () => {
            expect(new RevocationRegistry([B, C]).predecessorIndexOf(B)).toBe(0)
        })

        it("rejects a commitment that is not revoked", () => {
            expect(() => new RevocationRegistry([A]).predecessorIndexOf(B)).toThrow("has not been revoked")
        })
    })

    describe("leafSlots and fromLeaves", () => {
        it("exposes every physical slot, sentinel and tombstones included", () => {
            const registry = new RevocationRegistry([A, B, C])

            registry.unrevoke(B)

            expect(registry.leafSlots).toEqual([
                { value: 0n, nextValue: A },
                { value: A, nextValue: C },
                { value: 0n, nextValue: 0n },
                { value: C, nextValue: 0n }
            ])
        })

        it("rebuilds a registry that the commitment list alone cannot", () => {
            const authority = new RevocationRegistry([A, B, C])

            authority.unrevoke(B)

            // What the constructor can see, and why it is not enough.
            expect(new RevocationRegistry(authority.commitments).root).not.toBe(authority.root)

            const rebuilt = RevocationRegistry.fromLeaves(authority.leafSlots)

            expect(rebuilt.root).toBe(authority.root)
            expect(rebuilt.size).toBe(authority.size)
            expect(rebuilt.commitments).toEqual(authority.commitments)
        })

        it("round-trips a registry with no tombstones", () => {
            const authority = new RevocationRegistry([C, A, B])

            expect(RevocationRegistry.fromLeaves(authority.leafSlots).root).toBe(authority.root)
        })

        it("produces a registry that still proves, indexes and accepts revocations", () => {
            const authority = new RevocationRegistry([A, B, C])

            authority.unrevoke(B)

            const rebuilt = RevocationRegistry.fromLeaves(authority.leafSlots)

            expect(rebuilt.verifyProof(rebuilt.generateProof(D))).toBe(true)
            expect(rebuilt.indexOf(C)).toBe(authority.indexOf(C))
            expect(rebuilt.lowLeafIndexOf(D)).toBe(authority.lowLeafIndexOf(D))

            rebuilt.revoke(D)
            authority.revoke(D)

            expect(rebuilt.root).toBe(authority.root)
        })

        it("rebuilds an empty registry from no slots", () => {
            expect(RevocationRegistry.fromLeaves([]).root).toBe(0n)
        })

        it.each([
            ["a tombstone in the middle", () => withRemovals([A, B, C], [B])],
            ["a tombstone in the first slot", () => withRemovals([A, B, C], [A])],
            ["a trailing tombstone", () => withRemovals([A, B, C], [C])],
            ["consecutive tombstones", () => withRemovals([A, B, C, D], [B, C])],
            ["every commitment removed", () => withRemovals([A, B], [A, B])],
            ["a slot removed and the value revoked again", () => reRevoked()],
            ["a commitment replaced in place", () => replaced()]
        ])("rebuilds a registry with %s", (_label, build) => {
            const authority = build()

            expect(RevocationRegistry.fromLeaves(authority.leafSlots).root).toBe(authority.root)
            expect(RevocationRegistry.import(authority.export()).root).toBe(authority.root)
        })

        it("keeps a tombstoned slot rather than compacting it away", () => {
            const authority = withRemovals([A, B, C], [C])

            // The removed slot still holds a Merkle position, so the slot count is unchanged
            // and rebuilding without it would produce a different root.
            expect(authority.leafSlots).toHaveLength(4)
            expect(authority.size).toBe(2)
            expect(authority.leafSlots[3]).toEqual({ value: 0n, nextValue: 0n })

            const withoutTombstone = authority.leafSlots.slice(0, 3)

            expect(RevocationRegistry.fromLeaves(withoutTombstone).root).not.toBe(authority.root)
        })

        it("rebuilds an emptied registry, whose sentinel is itself a tombstone", () => {
            const authority = withRemovals([A, B], [A, B])
            const rebuilt = RevocationRegistry.fromLeaves(authority.leafSlots)

            expect(authority.root).not.toBe(0n)
            expect(rebuilt.root).toBe(authority.root)
            expect(rebuilt.size).toBe(0)
            // Nothing is revoked, so every commitment proves non-membership again.
            expect(rebuilt.generateProof(A).proofType).toBe(PROOF_TYPE.NON_MEMBERSHIP)
        })

        it("rebuilds trees whose levels have unpaired nodes", () => {
            // Slot counts that force a promotion: 3 slots pair once and promote one,
            // 5 slots promote at two different levels. Even counts never take that path.
            for (const commitments of [
                [A, B],
                [A, B, C, D],
                [A, B, C, D, 500n, 600n]
            ]) {
                const authority = new RevocationRegistry(commitments)

                expect(authority.leafSlots).toHaveLength(commitments.length + 1)
                expect(RevocationRegistry.fromLeaves(authority.leafSlots).root).toBe(authority.root)
            }
        })

        it("rejects slots that do not start with the sentinel", () => {
            expect(() => RevocationRegistry.fromLeaves([{ value: A, nextValue: 0n }])).toThrow("must be the sentinel")
        })

        it("rejects slots outside the field", () => {
            expect(() =>
                RevocationRegistry.fromLeaves([
                    { value: 0n, nextValue: A },
                    { value: SNARK_SCALAR_FIELD, nextValue: 0n }
                ])
            ).toThrow("SNARK scalar field")
        })
    })

    describe("export and import", () => {
        it("declares the snapshot format version it writes", () => {
            expect(JSON.parse(new RevocationRegistry([A]).export()).version).toBe(SNAPSHOT_VERSION)
        })

        it("round-trips a snapshot without recomputing hashes", () => {
            const tree = new RevocationRegistry([A, B, C])
            const restored = RevocationRegistry.import(tree.export())

            expect(restored.root).toBe(tree.root)
            expect(restored.commitments).toEqual(tree.commitments)
            expect(restored.generateProof(D).root).toBe(tree.root)
        })

        it("rejects a snapshot whose leaves and hashes disagree", () => {
            const tree = new RevocationRegistry([A, B, C])
            const tampered = tree.export().replace('"200"', '"250"')

            expect(() => RevocationRegistry.import(tampered)).toThrow()
        })

        // Poseidon reduces mod p, so an aliased leaf hashes to the honest root; only a range check
        // stops a served snapshot from hiding a revocation behind it.
        describe.each(["value", "nextValue"] as const)(
            "a leaf whose %s is a field element plus the field order",
            (field) => {
                const aliased = (): string => {
                    const snapshot = JSON.parse(new RevocationRegistry([A, B, C]).export()) as {
                        leaves: { value: string; nextValue: string }[]
                    }
                    const leaf = snapshot.leaves.find((candidate) => candidate.value === "200")!
                    leaf[field] = (BigInt(leaf[field]) + SNARK_SCALAR_FIELD).toString()
                    return JSON.stringify(snapshot)
                }

                it("passes the library's own rehash to the honest root, which is why import must range-check it", () => {
                    expect(LeanIMTPlus.import(revocationHashes, aliased(), { validate: true }).root).toBe(
                        new RevocationRegistry([A, B, C]).root
                    )
                })

                it("is rejected on import", () => {
                    expect(() => RevocationRegistry.import(aliased())).toThrow("SNARK scalar field")
                })
            }
        )

        it("skips validation when the snapshot is trusted", () => {
            const tree = new RevocationRegistry([A, B, C])

            expect(RevocationRegistry.import(tree.export(), false).root).toBe(tree.root)
        })
    })
})
