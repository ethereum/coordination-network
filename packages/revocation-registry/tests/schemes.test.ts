import { createHash } from "node:crypto"
import { describe, expect, it } from "@jest/globals"
import type { RevocationScheme } from "../src"
import {
    PROOF_TYPE,
    RevocationRegistry,
    SHA256_VALUE_BOUND,
    SNARK_SCALAR_FIELD,
    TAG_LEAF,
    poseidonScheme,
    sha256Hash2,
    sha256Hash3,
    sha256Hashes,
    sha256Scheme,
    toCommitment,
    toFieldElement
} from "../src"

const A = 100n
const B = 200n
const C = 300n
const D = 400n

/** An independent reference: node's SHA-256 over 32-byte big-endian words. */
function referenceHash(...values: bigint[]): bigint {
    const encode = (x: bigint) => Buffer.from(x.toString(16).padStart(64, "0"), "hex")
    const digest = createHash("sha256")
        .update(Buffer.concat(values.map(encode)))
        .digest("hex")

    return BigInt(`0x${digest}`)
}

describe("SHA-256 hashes", () => {
    it.each([
        [0n, 0n],
        [1n, 2n],
        [A, B],
        [SHA256_VALUE_BOUND - 1n, 1n]
    ])("hash a node like an independent SHA-256 for (%s, %s)", (a, b) => {
        expect(sha256Hash2(a, b)).toBe(referenceHash(a, b))
    })

    it("hash a leaf over the value, next value and tag", () => {
        expect(sha256Hashes.leaf(A, B, TAG_LEAF)).toBe(referenceHash(A, B, TAG_LEAF))
        expect(sha256Hash3(A, B, TAG_LEAF)).toBe(referenceHash(A, B, TAG_LEAF))
    })

    it("reject inputs with no 32-byte encoding", () => {
        expect(() => sha256Hash2(SHA256_VALUE_BOUND, 0n)).toThrow("2^256")
        expect(() => sha256Hash2(0n, SHA256_VALUE_BOUND)).toThrow("2^256")
        expect(() => sha256Hash2(-1n, 0n)).toThrow("2^256")
    })
})

describe("RevocationRegistry under the SHA-256 scheme", () => {
    it("defaults to the Poseidon scheme", () => {
        expect(new RevocationRegistry().scheme).toBe(poseidonScheme)
    })

    it("builds a root a caller can reproduce from the SHA-256 hashes", () => {
        const leaf = (value: bigint, nextValue: bigint) => sha256Hashes.leaf(value, nextValue, TAG_LEAF)
        const root = sha256Hashes.internal(sha256Hashes.internal(leaf(0n, A), leaf(A, B)), leaf(B, 0n))

        expect(new RevocationRegistry([A, B], sha256Scheme).root).toBe(root)
    })

    it("produces a root unrelated to the Poseidon one for the same commitments", () => {
        expect(new RevocationRegistry([A, B], sha256Scheme).root).not.toBe(new RevocationRegistry([A, B]).root)
    })

    it("accepts commitments up to 2^256 - 1 and rejects anything above", () => {
        const registry = new RevocationRegistry([], sha256Scheme)

        registry.revoke(SHA256_VALUE_BOUND - 1n)

        expect(registry.isRevoked(SHA256_VALUE_BOUND - 1n)).toBe(true)
        expect(() => registry.revoke(SHA256_VALUE_BOUND)).toThrow("2^256")
        expect(() => registry.generateProof(SHA256_VALUE_BOUND)).toThrow("2^256")
    })

    it("range-checks through the exported helpers when given the scheme", () => {
        expect(toCommitment(SHA256_VALUE_BOUND - 1n, sha256Scheme)).toBe(SHA256_VALUE_BOUND - 1n)
        expect(() => toCommitment(SHA256_VALUE_BOUND, sha256Scheme)).toThrow("2^256")
        expect(() => toFieldElement(SHA256_VALUE_BOUND, sha256Scheme)).toThrow("2^256")
    })

    it("generates non-membership and membership proofs that verify", () => {
        const registry = new RevocationRegistry([A, C], sha256Scheme)
        const absent = registry.generateProof(B)
        const present = registry.generateProof(C)

        expect(absent.proofType).toBe(PROOF_TYPE.NON_MEMBERSHIP)
        expect(present.proofType).toBe(PROOF_TYPE.MEMBERSHIP)
        expect(registry.verifyProof(absent)).toBe(true)
        expect(registry.verifyProof(present)).toBe(true)
    })

    it("verifies a proof statically only under the scheme it was built with", () => {
        const proof = new RevocationRegistry([A, C], sha256Scheme).generateProof(B)

        expect(RevocationRegistry.verifyProof(proof, sha256Scheme)).toBe(true)
        expect(RevocationRegistry.verifyProof(proof)).toBe(false)
    })

    it("keeps its scheme through export and import", () => {
        const registry = new RevocationRegistry([A, B, C], sha256Scheme)
        const restored = RevocationRegistry.import(registry.export(), true, sha256Scheme)

        expect(restored.scheme).toBe(sha256Scheme)
        expect(restored.root).toBe(registry.root)

        restored.revoke(D)
        registry.revoke(D)

        expect(restored.root).toBe(registry.root)
    })

    it("rejects a snapshot imported under the wrong scheme", () => {
        const snapshot = new RevocationRegistry([A, B, C], sha256Scheme).export()

        expect(() => RevocationRegistry.import(snapshot)).toThrow()
        expect(() => RevocationRegistry.import(new RevocationRegistry([A, B]).export(), true, sha256Scheme)).toThrow()
    })

    it("rejects a snapshot leaf outside the 256-bit range", () => {
        const snapshot = JSON.parse(new RevocationRegistry([A, B, C], sha256Scheme).export()) as {
            leaves: { value: string; nextValue: string }[]
        }
        const leaf = snapshot.leaves.find((candidate) => candidate.value === B.toString())!

        leaf.value = (B + SHA256_VALUE_BOUND).toString()

        expect(() => RevocationRegistry.import(JSON.stringify(snapshot), true, sha256Scheme)).toThrow("2^256")
    })

    it("rebuilds the identical tree from its leaf slots, tombstones included", () => {
        const registry = new RevocationRegistry([A, B, C], sha256Scheme)

        registry.unrevoke(B)

        const rebuilt = RevocationRegistry.fromLeaves(registry.leafSlots, sha256Scheme)

        expect(rebuilt.scheme).toBe(sha256Scheme)
        expect(rebuilt.root).toBe(registry.root)
        expect(RevocationRegistry.fromLeaves([], sha256Scheme).scheme).toBe(sha256Scheme)
    })

    it("rejects leaf slots outside the 256-bit range", () => {
        expect(() =>
            RevocationRegistry.fromLeaves(
                [
                    { value: 0n, nextValue: A },
                    { value: SHA256_VALUE_BOUND, nextValue: 0n }
                ],
                sha256Scheme
            )
        ).toThrow("2^256")
    })

    it("computes batched low leaf indices against SHA-256 state", () => {
        const registry = new RevocationRegistry([B], sha256Scheme)
        const indices = registry.lowLeafIndicesOf([D, A, C])
        const incremental = new RevocationRegistry([B], sha256Scheme)
        const expected = [D, A, C].map((commitment) => {
            const index = incremental.lowLeafIndexOf(commitment)
            incremental.revoke(commitment)
            return index
        })

        expect(indices).toEqual(expected)
        expect(registry.size).toBe(1)
    })
})

describe("RevocationRegistry under a caller-defined scheme", () => {
    const P = (1n << 61n) - 1n
    const mix = (...values: bigint[]) => values.reduce((acc, value) => (acc * 1_000_003n + value + 1n) % P, 7n)
    const customScheme: RevocationScheme = {
        hashes: { leaf: (a, b, c) => mix(1n, a, b, c), internal: (a, b) => mix(2n, a, b) },
        bound: P
    }

    it("builds its root from the scheme's own hash functions", () => {
        const leaf = (value: bigint, nextValue: bigint) => customScheme.hashes.leaf(value, nextValue, TAG_LEAF)
        const root = customScheme.hashes.internal(customScheme.hashes.internal(leaf(0n, A), leaf(A, B)), leaf(B, 0n))

        expect(new RevocationRegistry([A, B], customScheme).root).toBe(root)
    })

    it("enforces the scheme's own field, with a generic message when it gives no description", () => {
        const registry = new RevocationRegistry([], customScheme)

        registry.revoke(P - 1n)

        expect(registry.isRevoked(P - 1n)).toBe(true)
        expect(() => registry.revoke(P)).toThrow("less than the scheme's bound")
        expect(() => toFieldElement(P, customScheme)).toThrow("less than the scheme's bound")
    })

    it("treats the index passed by point-free map as the default scheme, as 0.2.1 did", () => {
        const pointFree = toCommitment as unknown as (value: bigint, index: number) => bigint

        expect([A, B].map(pointFree)).toEqual([A, B])
        expect(() => [A, SNARK_SCALAR_FIELD].map(pointFree)).toThrow("SNARK scalar field order")
    })

    it("rejects a scheme without a bigint bound instead of skipping the range check", () => {
        expect(() => toFieldElement(1n, {} as RevocationScheme)).toThrow("bigint bound")
        expect(() => new RevocationRegistry([A], {} as RevocationScheme)).toThrow("bigint bound")
    })

    it("proves, verifies and rebuilds under the scheme", () => {
        const registry = new RevocationRegistry([A, C, D], customScheme)

        registry.unrevoke(C)

        const proof = registry.generateProof(B)

        expect(proof.proofType).toBe(PROOF_TYPE.NON_MEMBERSHIP)
        expect(RevocationRegistry.verifyProof(proof, customScheme)).toBe(true)
        expect(RevocationRegistry.import(registry.export(), true, customScheme).root).toBe(registry.root)
        expect(RevocationRegistry.fromLeaves(registry.leafSlots, customScheme).root).toBe(registry.root)
        expect(registry.lowLeafIndicesOf([B, C])).toHaveLength(2)
    })
})
