import { createHash } from "node:crypto"
import { describe, expect, it } from "@jest/globals"
import { poseidon2 } from "poseidon-lite/poseidon2"
import type { IssuerScheme } from "../src"
import {
    IssuerRegistry,
    SHA256_VALUE_BOUND,
    SNARK_SCALAR_FIELD,
    poseidonHash2,
    poseidonScheme,
    sha256Hash2,
    sha256Scheme,
    toCommitment,
    toFieldElement
} from "../src"

const A = 100n
const B = 200n
const C = 300n

/** An independent reference: node's SHA-256 over 32-byte big-endian words. */
function referenceHash(...values: bigint[]): bigint {
    const encode = (x: bigint) => Buffer.from(x.toString(16).padStart(64, "0"), "hex")
    const digest = createHash("sha256")
        .update(Buffer.concat(values.map(encode)))
        .digest("hex")

    return BigInt(`0x${digest}`)
}

describe("hashes", () => {
    it.each([
        [0n, 0n],
        [1n, 2n],
        [A, B],
        [SHA256_VALUE_BOUND - 1n, 1n]
    ])("SHA-256 hashes a node like an independent SHA-256 for (%s, %s)", (a, b) => {
        expect(sha256Hash2(a, b)).toBe(referenceHash(a, b))
    })

    it("SHA-256 rejects inputs with no 32-byte encoding", () => {
        expect(() => sha256Hash2(SHA256_VALUE_BOUND, 0n)).toThrow("2^256")
        expect(() => sha256Hash2(0n, SHA256_VALUE_BOUND)).toThrow("2^256")
        expect(() => sha256Hash2(-1n, 0n)).toThrow("2^256")
    })

    it("Poseidon hashes a node with 2-input Poseidon", () => {
        expect(poseidonHash2(A, B)).toBe(poseidon2([A, B]))
    })
})

describe("schemes", () => {
    it("defaults to the Poseidon scheme", () => {
        expect(new IssuerRegistry().scheme).toBe(poseidonScheme)
    })

    it.each([
        ["Poseidon", poseidonScheme],
        ["SHA-256", sha256Scheme]
    ])("builds a %s root a caller can reproduce, promoting the unpaired node", (_, scheme) => {
        expect(new IssuerRegistry([A, B, C], scheme).root).toBe(scheme.hash(scheme.hash(A, B), C))
    })

    it("gives different roots for the same commitments under different schemes", () => {
        expect(new IssuerRegistry([A, B], sha256Scheme).root).not.toBe(new IssuerRegistry([A, B]).root)
    })

    it("accepts SHA-256 commitments up to 2^256 - 1 and above the BN254 field", () => {
        const registry = new IssuerRegistry([SNARK_SCALAR_FIELD, SHA256_VALUE_BOUND - 1n], sha256Scheme)

        expect(registry.isIssuer(SHA256_VALUE_BOUND - 1n)).toBe(true)
        expect(() => registry.addIssuer(SHA256_VALUE_BOUND)).toThrow("2^256")
        expect(() => new IssuerRegistry([SNARK_SCALAR_FIELD])).toThrow("SNARK scalar field order")
    })

    it("verifies proofs under the scheme they were built with only", () => {
        const proof = new IssuerRegistry([A, B, C], sha256Scheme).generateProof(B)

        expect(IssuerRegistry.verifyProof(proof, sha256Scheme)).toBe(true)
        expect(IssuerRegistry.verifyProof(proof)).toBe(false)
    })

    it("rebuilds from leaves and snapshots under the given scheme", () => {
        const registry = new IssuerRegistry([A, B, C], sha256Scheme)

        registry.removeIssuer(B)

        expect(IssuerRegistry.fromLeaves(registry.leaves, sha256Scheme).root).toBe(registry.root)
        expect(IssuerRegistry.import(registry.export(), true, sha256Scheme).root).toBe(registry.root)
        expect(() => IssuerRegistry.import(registry.export())).toThrow("do not match")
    })

    it("supports a custom scheme without a bound description", () => {
        const scheme: IssuerScheme = { hash: (a, b) => (a * 31n + b) % 1009n, bound: 1009n }
        const registry = new IssuerRegistry([1n, 2n, 3n], scheme)

        expect(registry.root).toBe(scheme.hash(scheme.hash(1n, 2n), 3n))
        expect(() => registry.addIssuer(1009n)).toThrow("scheme's bound")
    })

    it("rejects a scheme without a bigint bound", () => {
        const scheme = { hash: poseidonHash2 } as unknown as IssuerScheme

        expect(() => new IssuerRegistry([A], scheme)).toThrow("bigint bound")
    })
})

describe("toCommitment and toFieldElement", () => {
    it("default to the Poseidon scheme", () => {
        expect(toCommitment("100")).toBe(A)
        expect(() => toCommitment(SNARK_SCALAR_FIELD)).toThrow("SNARK scalar field order")
        expect(toFieldElement(0)).toBe(0n)
    })

    it("reject a scheme that is not one, such as the index `map` passes", () => {
        const asMapper = (f: typeof toCommitment) => f as unknown as (value: string, index: number) => bigint

        expect(() => ["1"].map(asMapper(toCommitment))).toThrow("bigint bound")
        expect(() => ["0"].map(asMapper(toFieldElement))).toThrow("bigint bound")
    })

    it("take a scheme", () => {
        expect(toCommitment(SNARK_SCALAR_FIELD, sha256Scheme)).toBe(SNARK_SCALAR_FIELD)
        expect(toFieldElement(SNARK_SCALAR_FIELD, sha256Scheme)).toBe(SNARK_SCALAR_FIELD)
    })

    it("reject zero and negative commitments and negative field elements", () => {
        expect(() => toCommitment(0)).toThrow("greater than zero")
        expect(() => toCommitment(-1)).toThrow("greater than zero")
        expect(() => toFieldElement(-1)).toThrow("must not be negative")
    })
})
