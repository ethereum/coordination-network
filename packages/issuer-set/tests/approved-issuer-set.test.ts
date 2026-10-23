import { describe, expect, it } from "@jest/globals"
import { Base8, addPoint, inCurve, mulPointEscalar } from "@zk-kit/baby-jubjub"
import {
    ApprovedIssuerSet,
    COFACTOR,
    ISSUER_LEAF_DOMAIN,
    ISSUER_SET_MAX_DEPTH,
    SNARK_SCALAR_FIELD,
    inPrimeOrderSubgroup,
    internalNode,
    issuerKeyLeaf,
    issuerLeaf,
    toFieldElement,
    toPublicKey
} from "../src"
import type { ContractLeafReader, IssuerPublicKey } from "../src"

/** `k * Base8`, so every test key is genuinely on Baby Jubjub. */
function key(k: number): IssuerPublicKey {
    return mulPointEscalar(Base8, BigInt(k)) as IssuerPublicKey
}

const KEY_A = key(1)
const KEY_B = key(2)
const KEY_C = key(3)

// Torsion points of orders 2, 4 and 8. Adding one to a prime-order key gives a point of order 2l, 4l or 8l.
const TORSION_2: [bigint, bigint] = [0n, SNARK_SCALAR_FIELD - 1n]
const TORSION_8: [bigint, bigint] = [
    17545522957889784193459637215142187266023652151580582754000402781682644312291n,
    4826523245007015323400664741523384119579596407052839571721035538011798951543n
]
const TORSION_4 = mulPointEscalar(TORSION_8, 2n)

const MIXED_ORDER_VARIANTS: Array<[string, [bigint, bigint]]> = [
    ["2l", TORSION_2],
    ["4l", TORSION_4],
    ["8l", TORSION_8]
]

function mixedOrder(base: IssuerPublicKey, torsion: [bigint, bigint]): [bigint, bigint] {
    return addPoint(base, torsion)
}

describe("ApprovedIssuerSet", () => {
    describe("construction", () => {
        it("rejects an empty set", () => {
            expect(() => new ApprovedIssuerSet([])).toThrow("approved issuer set must not be empty")
        })

        it("rejects more keys than the tree can hold", () => {
            const tooMany = new Array(2 ** ISSUER_SET_MAX_DEPTH + 1).fill(KEY_A) as IssuerPublicKey[]

            expect(() => new ApprovedIssuerSet(tooMany)).toThrow("exceeds circuit capacity")
        })

        it("rejects a duplicate key", () => {
            expect(() => new ApprovedIssuerSet([KEY_A, KEY_B, KEY_A])).toThrow("duplicate key")
        })

        it("publishes the keys it is constructed with, at their given order", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B])

            expect(set.size).toBe(2)
            expect(set.leafCount).toBe(2)
            expect(set.isApproved(KEY_A)).toBe(true)
            expect(set.isApproved(KEY_B)).toBe(true)
            expect(set.indexOf(KEY_A)).toBe(0)
            expect(set.indexOf(KEY_B)).toBe(1)
        })

        it("does not curve-validate, mirroring an already-validated on-chain state", () => {
            expect(() => new ApprovedIssuerSet([[KEY_A[0], KEY_B[1]]])).not.toThrow()
        })
    })

    describe("indexOf / isApproved", () => {
        it("returns -1 and false for a key that was never published", () => {
            const set = new ApprovedIssuerSet([KEY_A])

            expect(set.indexOf(KEY_B)).toBe(-1)
            expect(set.isApproved(KEY_B)).toBe(false)
        })
    })

    describe("depth", () => {
        it("tracks ceil(log2(leafCount)) as keys are published", () => {
            const set = new ApprovedIssuerSet([KEY_A])
            const rest = [KEY_B, KEY_C, key(4), key(5)]
            const expected = [0, 1, 2, 2, 3]

            expect(set.depth).toBe(expected[0])

            rest.forEach((publicKey, i) => {
                set.publish(publicKey)
                expect(set.depth).toBe(expected[i + 1])
            })
        })
    })

    describe("leafSlots", () => {
        it("returns a copy: mutating it does not affect the set", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B])
            const leafCountBefore = set.leafCount

            const slots = set.leafSlots
            slots[0] = 0n
            slots.push(123n)

            expect(set.leafSlots).toEqual([ApprovedIssuerSet.leafOf(KEY_A), ApprovedIssuerSet.leafOf(KEY_B)])
            expect(set.leafCount).toBe(leafCountBefore)
        })
    })

    describe("publish", () => {
        it("returns the leaf and appends a new slot", () => {
            const set = new ApprovedIssuerSet([KEY_A])
            const leafCountBefore = set.leafCount

            const leaf = set.publish(KEY_B)

            expect(leaf).toBe(issuerKeyLeaf(KEY_B))
            expect(set.isApproved(KEY_B)).toBe(true)
            expect(set.leafCount).toBe(leafCountBefore + 1)
            expect(set.size).toBe(2)
        })

        it("moves the root", () => {
            const set = new ApprovedIssuerSet([KEY_A])
            const before = set.root

            set.publish(KEY_B)

            expect(set.root).not.toBe(before)
        })

        it("rejects a key that is already approved", () => {
            const set = new ApprovedIssuerSet([KEY_A])

            expect(() => set.publish(KEY_A)).toThrow("duplicate key")
        })

        it("rejects an off-curve key", () => {
            const set = new ApprovedIssuerSet([KEY_A])

            expect(() => set.publish([KEY_A[0], KEY_B[1]])).toThrow("not a point on Baby Jubjub")
        })
    })

    describe("publishMany", () => {
        it("matches publishing one at a time", () => {
            const batched = new ApprovedIssuerSet([KEY_A])
            const oneByOne = new ApprovedIssuerSet([KEY_A])

            const leaves = batched.publishMany([KEY_B, KEY_C])
            oneByOne.publish(KEY_B)
            oneByOne.publish(KEY_C)

            expect(leaves).toHaveLength(2)
            expect(batched.root).toBe(oneByOne.root)
        })

        it("returns [] and leaves the tree untouched for an empty batch", () => {
            const set = new ApprovedIssuerSet([KEY_A])
            const rootBefore = set.root

            expect(set.publishMany([])).toEqual([])
            expect(set.root).toBe(rootBefore)
            expect(set.leafCount).toBe(1)
        })

        it("rejects a key already approved", () => {
            const set = new ApprovedIssuerSet([KEY_A])

            expect(() => set.publishMany([KEY_B, KEY_A])).toThrow("duplicate key")
        })

        it("rejects a duplicate within the same batch", () => {
            const set = new ApprovedIssuerSet([KEY_A])

            expect(() => set.publishMany([KEY_B, KEY_B])).toThrow("duplicate key")
        })

        it("rejects a batch holding a mixed-order key and leaves the set unchanged", () => {
            const set = new ApprovedIssuerSet([KEY_A])
            const rootBefore = set.root

            expect(() => set.publishMany([KEY_B, mixedOrder(KEY_C, TORSION_8)])).toThrow(
                "not in the prime-order subgroup"
            )
            expect(set.root).toBe(rootBefore)
            expect(set.leafCount).toBe(1)
        })
    })

    describe("retire", () => {
        it("tombstones the slot and keeps it allocated", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B])
            const leafCountBefore = set.leafCount

            set.retire(KEY_A)

            expect(set.isApproved(KEY_A)).toBe(false)
            expect(set.isApproved(KEY_B)).toBe(true)
            expect(set.size).toBe(1)
            expect(set.leafCount).toBe(leafCountBefore)
        })

        it("leaves a zero root once the only key is retired", () => {
            const set = new ApprovedIssuerSet([KEY_A])

            set.retire(KEY_A)

            expect(set.size).toBe(0)
            expect(set.root).toBe(0n)
        })

        it("leaves a non-zero root when a key is retired but another remains", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B])

            set.retire(KEY_A)

            expect(set.size).toBe(1)
            expect(set.root).not.toBe(0n)
        })

        it("rejects a key that was never published", () => {
            const set = new ApprovedIssuerSet([KEY_A])

            expect(() => set.retire(KEY_B)).toThrow("credential issuer is not in the approved set")
        })

        it("allows republishing a retired key at a new slot", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B])
            const oldIndex = set.indexOf(KEY_A)

            set.retire(KEY_A)
            set.publish(KEY_A)

            expect(set.isApproved(KEY_A)).toBe(true)
            expect(set.indexOf(KEY_A)).toBe(set.leafCount - 1)
            expect(set.indexOf(KEY_A)).not.toBe(oldIndex)
            expect(set.leafSlots[oldIndex]).toBe(0n)
        })
    })

    describe("generateProof", () => {
        it("returns a witness whose siblings and indices match the set's depth, and verifies", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B, KEY_C])
            const proof = set.generateProof(KEY_B)

            expect(proof.root).toBe(set.root)
            expect(proof.siblings).toHaveLength(set.depth)
            expect(proof.indices).toHaveLength(set.depth)
            expect(proof.pathIndex).toBe(1)
            expect(set.verifyProof(proof)).toBe(true)
            expect(ApprovedIssuerSet.verifyProof(proof)).toBe(true)
        })

        it("throws for a key that was never approved", () => {
            const set = new ApprovedIssuerSet([KEY_A])

            expect(() => set.generateProof(KEY_B)).toThrow("credential issuer is not in the approved set")
        })

        it("throws for a retired key", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B])

            set.retire(KEY_A)

            expect(() => set.generateProof(KEY_A)).toThrow("credential issuer is not in the approved set")
        })
    })

    describe("verifyProof", () => {
        it("rejects a proof against a stale root", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B])
            const proof = set.generateProof(KEY_A)

            set.publish(KEY_C)

            expect(set.verifyProof(proof)).toBe(false)
        })

        it("rejects a proof carrying the wrong root", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B])
            const proof = set.generateProof(KEY_A)

            expect(ApprovedIssuerSet.verifyProof({ ...proof, root: proof.root + 1n })).toBe(false)
        })

        // The stale/wrong-root cases are settled by the root comparison alone, so without this the
        // Merkle fold itself never returns false in the suite and could be dropped unnoticed.
        it("rejects a proof whose sibling has been tampered with", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B, KEY_C])
            const proof = set.generateProof(KEY_B)
            const tampered = { ...proof, siblings: [...proof.siblings] }

            tampered.siblings[0] += 1n

            expect(set.verifyProof(tampered)).toBe(false)
            expect(ApprovedIssuerSet.verifyProof(tampered)).toBe(false)
        })

        it("rejects a witness with the wrong number of siblings or indices", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B, KEY_C])
            const proof = set.generateProof(KEY_B)

            expect(ApprovedIssuerSet.verifyProof({ ...proof, siblings: proof.siblings.slice(1) })).toBe(false)

            // An extra trailing `false` still packs to the same pathIndex, so this depends on the
            // length check alone: without it, the packed-index and root-fold checks both still pass.
            expect(ApprovedIssuerSet.verifyProof({ ...proof, indices: [...proof.indices, false] })).toBe(false)
        })

        it("rejects a witness whose indices do not pack to its pathIndex", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B, KEY_C])
            const proof = set.generateProof(KEY_B)
            const tampered = { ...proof, indices: proof.indices.map((bit) => !bit) }

            expect(ApprovedIssuerSet.verifyProof(tampered)).toBe(false)
        })
    })

    describe("fromLeaves", () => {
        it("round-trips a set built from public keys", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B, KEY_C])
            const rebuilt = ApprovedIssuerSet.fromLeaves(set.leafSlots)

            expect(rebuilt.root).toBe(set.root)
            expect(rebuilt.leafCount).toBe(set.leafCount)
            expect(rebuilt.size).toBe(set.size)
        })

        it("round-trips a set with a tombstone in it", () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B, KEY_C])

            set.retire(KEY_B)

            const rebuilt = ApprovedIssuerSet.fromLeaves(set.leafSlots)

            expect(rebuilt.root).toBe(set.root)
            expect(rebuilt.size).toBe(set.size)
        })

        it("rejects an empty slot table", () => {
            expect(() => ApprovedIssuerSet.fromLeaves([])).toThrow("approved issuer set must not be empty")
        })

        it("accepts an all-tombstone drained slot table", () => {
            const set = ApprovedIssuerSet.fromLeaves([0n, 0n, 0n])

            expect(set.size).toBe(0)
            expect(set.leafCount).toBe(3)
            expect(set.root).not.toBe(0n)
        })

        // Promotion, not literal-zero padding: a lone node is carried up unchanged rather than hashed
        // with a zero sibling, so appending a tombstone changes the tree's depth and its root.
        it("distinguishes a short leaf list from the same list padded with one tombstone", () => {
            const leafA = ApprovedIssuerSet.leafOf(KEY_A)

            expect(ApprovedIssuerSet.fromLeaves([leafA]).root).not.toBe(ApprovedIssuerSet.fromLeaves([leafA, 0n]).root)
        })

        it("agrees with an incrementally built set after a mixed history of publishes and retirements", () => {
            const keys = [KEY_A, KEY_B, KEY_C, key(4), key(5), key(6)]
            const set = new ApprovedIssuerSet([keys[0]])
            const assertAgreesWithFromLeaves = () => {
                const rebuilt = ApprovedIssuerSet.fromLeaves(set.leafSlots)
                expect(rebuilt.root).toBe(set.root)
                expect(rebuilt.leafCount).toBe(set.leafCount)
            }

            assertAgreesWithFromLeaves()
            set.publish(keys[1])
            assertAgreesWithFromLeaves()
            set.publishMany([keys[2], keys[3]])
            assertAgreesWithFromLeaves()
            set.retire(keys[0])
            assertAgreesWithFromLeaves()
            set.publish(keys[4])
            assertAgreesWithFromLeaves()
            // Retiring the current last slot: no slot after it to promote in its place.
            set.retire(keys[4])
            assertAgreesWithFromLeaves()
            set.publish(keys[5])
            assertAgreesWithFromLeaves()
        })
    })

    describe("fromContract", () => {
        it("rebuilds from a stub reader's leaves", async () => {
            const set = new ApprovedIssuerSet([KEY_A, KEY_B, KEY_C])
            const reader: ContractLeafReader = {
                getLeafCount: async () => set.leafCount,
                getLeaves: async (start, end) => set.leafSlots.slice(start, end)
            }

            const rebuilt = await ApprovedIssuerSet.fromContract(reader)

            expect(rebuilt.root).toBe(set.root)
            expect(rebuilt.leafCount).toBe(set.leafCount)
        })

        it("pages through getLeaves for a set larger than one page", async () => {
            const leaves = Array.from({ length: 1001 }, (_, i) => BigInt(i + 1))
            let calls = 0
            const reader: ContractLeafReader = {
                getLeafCount: async () => leaves.length,
                getLeaves: async (start, end) => {
                    calls += 1
                    return leaves.slice(start, end)
                }
            }

            const rebuilt = await ApprovedIssuerSet.fromContract(reader)

            expect(calls).toBe(2)
            expect(rebuilt.leafCount).toBe(1001)
            expect(rebuilt.root).toBe(ApprovedIssuerSet.fromLeaves(leaves).root)
        })

        it("throws when the contract has never published anything", async () => {
            const reader: ContractLeafReader = { getLeafCount: async () => 0, getLeaves: async () => [] }

            await expect(ApprovedIssuerSet.fromContract(reader)).rejects.toThrow(
                "approved issuer set must not be empty"
            )
        })

        // A tombstone at a promoted position (slot 4 of 5 is promoted twice before it meets a sibling)
        // is the case most likely to desync the rebuild path from the incrementally built set: if
        // `fromContract`/`fromLeaves` compacted a retired slot away, or mishandled a leaf that used to
        // be a bare promotion, the two sets would still agree on the root by coincidence far more often
        // than they would agree on every proof's siblings and pathIndex.
        it("reproduces generateProof witnesses of a publish-and-retire history when the tombstone sits at a promoted slot", async () => {
            const keys = [KEY_A, KEY_B, KEY_C, key(4), key(5)]
            const reference = new ApprovedIssuerSet(keys)
            reference.retire(key(5)) // slot 4: the promoted node of a 5-slot tree

            expect(reference.leafSlots[4]).toBe(0n)

            const reader: ContractLeafReader = {
                getLeafCount: async () => reference.leafCount,
                getLeaves: async (start, end) => reference.leafSlots.slice(start, end)
            }
            const rebuilt = await ApprovedIssuerSet.fromContract(reader)

            expect(rebuilt.root).toBe(reference.root)
            expect(rebuilt.leafCount).toBe(reference.leafCount)
            expect(rebuilt.depth).toBe(reference.depth)
            expect(rebuilt.leafSlots).toEqual(reference.leafSlots)

            for (const publicKey of [KEY_A, KEY_B, KEY_C, key(4)]) {
                expect(rebuilt.generateProof(publicKey)).toEqual(reference.generateProof(publicKey))
            }
        })
    })

    describe("leafOf", () => {
        it("computes the leaf a key would occupy without publishing it", () => {
            expect(ApprovedIssuerSet.leafOf(KEY_A)).toBe(issuerKeyLeaf(KEY_A))
        })
    })
})

describe("package exports", () => {
    // Pinned literals, not derived: a silent change here would desync every root this package computes
    // from `IssuerSetHashes.sol` and the circuit's `issuer.nr`.
    it("pins the cross-language constants", () => {
        expect(SNARK_SCALAR_FIELD).toBe(21888242871839275222246405745257275088548364400416034343698204186575808495617n)
        expect(COFACTOR).toBe(8n)
        expect(ISSUER_SET_MAX_DEPTH).toBe(20)
        expect(ISSUER_LEAF_DOMAIN).toBe(185404551131306766954100762329350135288498146007932686448214248919067924295n)
    })

    it("exposes issuerLeaf as the name packages/credential re-exports", () => {
        expect(issuerLeaf).toBe(issuerKeyLeaf)
    })

    it("exposes internalNode as an order-sensitive 2-input hash", () => {
        const set = new ApprovedIssuerSet([KEY_A, KEY_B])

        expect(internalNode(issuerKeyLeaf(KEY_A), issuerKeyLeaf(KEY_B))).not.toBe(
            internalNode(issuerKeyLeaf(KEY_B), issuerKeyLeaf(KEY_A))
        )
        // Two leaves: the tree has depth 1, so the root is the single fold of the two leaves.
        expect(set.root).toBe(internalNode(issuerKeyLeaf(KEY_A), issuerKeyLeaf(KEY_B)))
    })
})

describe("validators", () => {
    it("accepts zero as a field element", () => {
        expect(toFieldElement(0)).toBe(0n)
    })

    it("rejects a negative field element", () => {
        expect(() => toFieldElement(-1)).toThrow("must not be negative")
    })

    it("rejects a value at or above the field order", () => {
        const order = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

        expect(() => toFieldElement(order)).toThrow("less than the SNARK scalar field order")
    })

    it("accepts decimal strings and numbers", () => {
        expect(toFieldElement("42")).toBe(42n)
    })

    it("accepts a point on the curve", () => {
        expect(toPublicKey(KEY_A)).toEqual([BigInt(KEY_A[0]), BigInt(KEY_A[1])])
    })

    /**
     * Every one of these satisfies the curve equation, so the curve check alone lets them through.
     * Under a low-order key the `h·A` term of EdDSA verification takes at most eight values, so a
     * stranger can solve for a signature over a claim tree of their choosing. The contract rejects the
     * same eight points, by x coordinate.
     */
    it.each([
        [0n, 1n],
        [0n, 21888242871839275222246405745257275088548364400416034343698204186575808495616n],
        [2957874849018779266517920829765869116077630550401372566248359756137677864698n, 0n],
        [18930368022820495955728484915491405972470733850014661777449844430438130630919n, 0n],
        [
            4342719913949491028786768530115087822524712248835451589697801404893164183326n,
            4826523245007015323400664741523384119579596407052839571721035538011798951543n
        ],
        [
            4342719913949491028786768530115087822524712248835451589697801404893164183326n,
            17061719626832259898845741003733890968968767993363194771977168648564009544074n
        ],
        [
            17545522957889784193459637215142187266023652151580582754000402781682644312291n,
            4826523245007015323400664741523384119579596407052839571721035538011798951543n
        ],
        [
            17545522957889784193459637215142187266023652151580582754000402781682644312291n,
            17061719626832259898845741003733890968968767993363194771977168648564009544074n
        ]
    ])("rejects the low-order point (%s, %s)", (x, y) => {
        expect(inCurve([x, y])).toBe(true)
        expect(() => toPublicKey([x, y])).toThrow("low order")
    })

    it.each(MIXED_ORDER_VARIANTS)("rejects a key plus a torsion point, giving order %s", (_, torsion) => {
        const variant = mixedOrder(KEY_A, torsion)

        expect(inCurve(variant)).toBe(true)
        expect(() => toPublicKey(variant)).toThrow(
            "ApprovedIssuerSet: the public key is not in the prime-order subgroup"
        )
    })

    it.each(MIXED_ORDER_VARIANTS)("refuses to publish a key of order %s", (_, torsion) => {
        const set = new ApprovedIssuerSet([KEY_B])

        expect(() => set.publish(mixedOrder(KEY_A, torsion))).toThrow("not in the prime-order subgroup")
    })

    it("rejects a non-canonical coordinate before the subgroup check", () => {
        expect(() => toPublicKey([KEY_A[0] + SNARK_SCALAR_FIELD, KEY_A[1]])).toThrow(
            "less than the SNARK scalar field order"
        )
    })

    describe("inPrimeOrderSubgroup", () => {
        it("accepts a prime-order key", () => {
            expect(inPrimeOrderSubgroup(KEY_A)).toBe(true)
        })

        it.each(MIXED_ORDER_VARIANTS)("rejects a key of order %s", (_, torsion) => {
            expect(inPrimeOrderSubgroup(mixedOrder(KEY_A, torsion))).toBe(false)
        })

        it("rejects the identity", () => {
            expect(inPrimeOrderSubgroup([0n, 1n])).toBe(false)
        })

        it("rejects a low-order point", () => {
            expect(inPrimeOrderSubgroup(TORSION_8)).toBe(false)
        })

        it("rejects a point off the curve", () => {
            expect(inPrimeOrderSubgroup([1n, 1n])).toBe(false)
        })

        it.each([
            ["x + p", [KEY_A[0] + SNARK_SCALAR_FIELD, KEY_A[1]]],
            ["y + p", [KEY_A[0], KEY_A[1] + SNARK_SCALAR_FIELD]],
            ["x - p, a negative alias", [KEY_A[0] - SNARK_SCALAR_FIELD, KEY_A[1]]]
        ] as Array<[string, [bigint, bigint]]>)("rejects a non-canonical coordinate: %s", (_, point) => {
            expect(inPrimeOrderSubgroup(point)).toBe(false)
        })
    })
})
