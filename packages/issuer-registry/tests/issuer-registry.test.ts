import { describe, expect, it } from "@jest/globals"
import { LeanIMT } from "@zk-kit/lean-imt"
import { IssuerRegistry, SNARK_SCALAR_FIELD, poseidonHash2 } from "../src"

const A = 100n
const B = 200n
const C = 300n
const D = 400n

describe("IssuerRegistry", () => {
    describe("state", () => {
        it("starts empty with a zero root", () => {
            const registry = new IssuerRegistry()

            expect(registry.root).toBe(0n)
            expect(registry.depth).toBe(0)
            expect(registry.size).toBe(0)
            expect(registry.leaves).toEqual([])
            expect(registry.commitments).toEqual([])
        })

        it("has a one-leaf root equal to the leaf", () => {
            expect(new IssuerRegistry([A]).root).toBe(A)
        })

        it("matches a plain LeanIMT over the same leaves", () => {
            const registry = new IssuerRegistry([A, B, C])
            const tree = new LeanIMT(poseidonHash2, [A, B, C])

            expect(registry.root).toBe(tree.root)
            expect(registry.depth).toBe(2)
            expect(registry.size).toBe(3)
        })

        it("accepts numbers and strings", () => {
            const registry = new IssuerRegistry([100, "200"])

            expect(registry.commitments).toEqual([A, B])
            expect(registry.isIssuer("100")).toBe(true)
            expect(registry.indexOf(200)).toBe(1)
        })
    })

    describe("addIssuer and addIssuers", () => {
        it("appends in order, matching a batch", () => {
            const oneByOne = new IssuerRegistry()

            oneByOne.addIssuer(C)
            oneByOne.addIssuer(A)
            oneByOne.addIssuer(B)

            expect(oneByOne.root).toBe(new IssuerRegistry([C, A, B]).root)
            expect(oneByOne.indexOf(B)).toBe(2)
        })

        it("rejects zero, out-of-range and duplicate commitments", () => {
            const registry = new IssuerRegistry([A])

            expect(() => registry.addIssuer(0)).toThrow("greater than zero")
            expect(() => registry.addIssuer(SNARK_SCALAR_FIELD)).toThrow("SNARK scalar field order")
            expect(() => registry.addIssuer(A)).toThrow("already an approved issuer")
        })

        it("adds a batch all or nothing", () => {
            const registry = new IssuerRegistry([A])

            expect(() => registry.addIssuers([B, A])).toThrow("already an approved issuer")
            expect(() => registry.addIssuers([B, C, B])).toThrow("duplicate")
            expect(() => registry.addIssuers([])).toThrow("no commitments")
            expect(registry.leaves).toEqual([A])

            registry.addIssuers([B, C])

            expect(registry.leaves).toEqual([A, B, C])
        })
    })

    describe("removeIssuer", () => {
        it("zeroes the leaf and keeps its slot", () => {
            const registry = new IssuerRegistry([A, B, C])

            registry.removeIssuer(B)

            expect(registry.isIssuer(B)).toBe(false)
            expect(registry.leaves).toEqual([A, 0n, C])
            expect(registry.commitments).toEqual([A, C])
            expect(registry.size).toBe(3)
            expect(registry.indexOf(C)).toBe(2)
            expect(registry.root).toBe(poseidonHash2(poseidonHash2(A, 0n), C))
        })

        it("empties a one-leaf registry to a zero root", () => {
            const registry = new IssuerRegistry([A])

            registry.removeIssuer(A)

            expect(registry.root).toBe(0n)
            expect(registry.size).toBe(1)
        })

        it("lets a removed issuer be added again in a new slot", () => {
            const registry = new IssuerRegistry([A, B])

            registry.removeIssuer(A)
            registry.addIssuer(A)

            expect(registry.leaves).toEqual([0n, B, A])
            expect(registry.indexOf(A)).toBe(2)
        })

        it("rejects a commitment that is not an issuer", () => {
            const registry = new IssuerRegistry([A])

            expect(() => registry.removeIssuer(B)).toThrow("not an approved issuer")
            expect(() => registry.removeIssuer(0)).toThrow("greater than zero")
        })
    })

    describe("updateIssuerCommitment", () => {
        it("reuses the slot", () => {
            const registry = new IssuerRegistry([A, B, C])

            registry.updateIssuerCommitment(B, D)

            expect(registry.leaves).toEqual([A, D, C])
            expect(registry.isIssuer(B)).toBe(false)
            expect(registry.root).toBe(new IssuerRegistry([A, D, C]).root)
        })

        it("rejects an unknown old commitment and an invalid or existing new one", () => {
            const registry = new IssuerRegistry([A, B])

            expect(() => registry.updateIssuerCommitment(C, D)).toThrow("not an approved issuer")
            expect(() => registry.updateIssuerCommitment(A, B)).toThrow("already an approved issuer")
            expect(() => registry.updateIssuerCommitment(A, 0)).toThrow("greater than zero")
            expect(registry.leaves).toEqual([A, B])
        })
    })

    describe("proofs", () => {
        it("proves every approved issuer against the current root", () => {
            const registry = new IssuerRegistry([A, B, C, D])

            registry.removeIssuer(C)

            for (const commitment of [A, B, D]) {
                const proof = registry.generateProof(commitment)

                expect(proof.leaf).toBe(commitment)
                expect(proof.root).toBe(registry.root)
                expect(registry.verifyProof(proof)).toBe(true)
                expect(IssuerRegistry.verifyProof(proof)).toBe(true)
            }
        })

        it("refuses to prove a commitment that is not an issuer", () => {
            const registry = new IssuerRegistry([A, B])

            registry.removeIssuer(A)

            expect(() => registry.generateProof(A)).toThrow("not an approved issuer")
            expect(() => registry.generateProof(C)).toThrow("not an approved issuer")
        })

        it("rejects a proof of a removed issuer's zero leaf", () => {
            const registry = new IssuerRegistry([A, B])

            registry.removeIssuer(A)

            const zeroLeafProof = registry.leanIMT.generateProof(0)

            expect(LeanIMT.verifyProof(zeroLeafProof, poseidonHash2)).toBe(true)
            expect(IssuerRegistry.verifyProof(zeroLeafProof)).toBe(false)
            expect(registry.verifyProof(zeroLeafProof)).toBe(false)
        })

        it("rejects an internal node passed off as a leaf, unless verifying statically", () => {
            const registry = new IssuerRegistry([A, B, C, D])
            const forged = {
                root: registry.root,
                leaf: poseidonHash2(A, B),
                index: 0,
                siblings: [poseidonHash2(C, D)]
            }

            expect(registry.verifyProof(forged)).toBe(false)
            expect(IssuerRegistry.verifyProof(forged)).toBe(true)
        })

        it("rejects a proof whose leaf or sibling is shifted by the field order", () => {
            const registry = new IssuerRegistry([A, B, C])
            const proof = registry.generateProof(B)
            const shift = (value: bigint) => value + SNARK_SCALAR_FIELD

            expect(IssuerRegistry.verifyProof({ ...proof, leaf: shift(proof.leaf) })).toBe(false)
            expect(registry.verifyProof({ ...proof, siblings: proof.siblings.map(shift) })).toBe(false)
            expect(IssuerRegistry.verifyProof({ ...proof, siblings: [-1n] })).toBe(false)
        })

        it("rejects a proof against a stale or forged root", () => {
            const registry = new IssuerRegistry([A, B])
            const proof = registry.generateProof(A)

            registry.addIssuer(C)

            expect(registry.verifyProof(proof)).toBe(false)
            expect(IssuerRegistry.verifyProof(proof)).toBe(true)
            expect(IssuerRegistry.verifyProof({ ...proof, root: proof.root + 1n })).toBe(false)
        })
    })

    describe("siblingNodesOf", () => {
        it("returns the siblings the contract checks, bottom up, skipping promoted levels", () => {
            const registry = new IssuerRegistry([A, B, C])

            expect(registry.siblingNodesOf(A)).toEqual([B, C])
            expect(registry.siblingNodesOf(C)).toEqual([poseidonHash2(A, B)])
        })

        it("lets a removal be replayed from the old root", () => {
            const registry = new IssuerRegistry([A, B, C, D])
            const siblings = registry.siblingNodesOf(B)
            const oldRoot = registry.root

            // As the contract does: the old root from the old leaf, the new one from zero.
            const index = registry.indexOf(B)
            const proof = { root: oldRoot, leaf: B, index, siblings }

            expect(IssuerRegistry.verifyProof(proof)).toBe(true)

            registry.removeIssuer(B)

            expect(LeanIMT.verifyProof({ ...proof, root: registry.root, leaf: 0n }, poseidonHash2)).toBe(true)
        })
    })

    describe("rebuilding", () => {
        function history(): IssuerRegistry {
            const registry = new IssuerRegistry([A, B, C, D])

            registry.removeIssuer(B)
            registry.updateIssuerCommitment(D, B)

            return registry
        }

        it("round-trips through leaves", () => {
            const registry = history()
            const rebuilt = IssuerRegistry.fromLeaves(registry.leaves)

            expect(rebuilt.root).toBe(registry.root)
            expect(rebuilt.leaves).toEqual(registry.leaves)
            expect(rebuilt.isIssuer(B)).toBe(true)
        })

        it("rebuilds an empty registry from no leaves", () => {
            expect(IssuerRegistry.fromLeaves([]).root).toBe(0n)
        })

        it("rejects leaves with a duplicate or out-of-range commitment", () => {
            expect(() => IssuerRegistry.fromLeaves([A, 0n, A])).toThrow("duplicate")
            expect(() => IssuerRegistry.fromLeaves([A, SNARK_SCALAR_FIELD])).toThrow("SNARK scalar field order")
            expect(IssuerRegistry.fromLeaves([0n, 0n, A]).commitments).toEqual([A])
        })

        it("round-trips through a snapshot", () => {
            const registry = history()
            const snapshot = registry.export()

            expect(IssuerRegistry.import(snapshot).root).toBe(registry.root)
            expect(IssuerRegistry.import(snapshot, false).root).toBe(registry.root)
            expect(IssuerRegistry.import(new IssuerRegistry().export()).root).toBe(0n)
        })

        it("rejects a snapshot whose nodes do not match its leaves", () => {
            const nodes = JSON.parse(history().export()) as string[][]

            nodes[nodes.length - 1][0] = "1"

            expect(() => IssuerRegistry.import(JSON.stringify(nodes))).toThrow("do not match")
            expect(IssuerRegistry.import(JSON.stringify(nodes), false).root).toBe(1n)
        })

        it("rejects a snapshot whose leaves are out of range or duplicated", () => {
            expect(() => IssuerRegistry.import(JSON.stringify([[SNARK_SCALAR_FIELD.toString()]]))).toThrow(
                "SNARK scalar field order"
            )
            expect(() => IssuerRegistry.import(JSON.stringify([["100", "100"], ["1"]]))).toThrow("duplicate")
        })

        it("rejects a snapshot that is not a list of levels", () => {
            expect(() => IssuerRegistry.import("{}")).toThrow("list of tree levels")
            expect(() => IssuerRegistry.import("[]")).toThrow("list of tree levels")
            expect(() => IssuerRegistry.import('["100"]')).toThrow("list of tree levels")
        })

        it("rejects a snapshot with non-string nodes", () => {
            expect(() => IssuerRegistry.import("[[100]]")).toThrow("do not match")
        })
    })
})
