import { LeanIMT } from "@zk-kit/lean-imt"
import { poseidonScheme } from "./schemes/poseidon"
import type { BigNumberish, IssuerProof, IssuerScheme } from "./types"
import { checkCommitment, checkFieldElement } from "./utils"

/**
 * A LeanIMT of approved issuer commitments. The {@link IssuerScheme} must match
 * the authority's. A mirror is trusted for availability only: compare
 * {@link root} with the authority's before using its proofs.
 */
export class IssuerRegistry {
    public leanIMT: LeanIMT<bigint>

    public readonly scheme: IssuerScheme

    /**
     * @param commitments In the authority's insertion order. After a removal,
     * use {@link fromLeaves} or {@link import} instead.
     * @param scheme Defaults to {@link poseidonScheme}.
     */
    constructor(commitments: BigNumberish[] = [], scheme: IssuerScheme = poseidonScheme) {
        this.scheme = scheme
        this.leanIMT = new LeanIMT(scheme.hash)

        if (commitments.length > 0) {
            this.addIssuers(commitments)
        }
    }

    /** `0` before the first add or once a one-leaf registry is emptied. */
    public get root(): bigint {
        return this.leanIMT.root ?? 0n
    }

    public get depth(): number {
        return this.leanIMT.depth
    }

    /** The number of leaves, removed issuers included. */
    public get size(): number {
        return this.leanIMT.size
    }

    /** Every leaf in index order, `0` for a removed issuer. Matches the contract's `getLeaf`. */
    public get leaves(): bigint[] {
        return this.leanIMT.leaves
    }

    /** The approved commitments, removed issuers left out. */
    public get commitments(): bigint[] {
        return this.leanIMT.leaves.filter((leaf) => leaf !== 0n)
    }

    public isIssuer(commitment: BigNumberish): boolean {
        return this.leanIMT.has(checkCommitment(commitment, this.scheme))
    }

    /** The leaf index of an approved commitment, or `-1`. */
    public indexOf(commitment: BigNumberish): number {
        return this.leanIMT.indexOf(checkCommitment(commitment, this.scheme))
    }

    public addIssuer(commitment: BigNumberish): void {
        this.leanIMT.insert(this.checkNew(commitment))
    }

    /** All or nothing. */
    public addIssuers(commitments: BigNumberish[]): void {
        if (commitments.length === 0) {
            throw new Error("IssuerRegistry: there are no commitments to add")
        }

        const existing = new Set(this.leanIMT.leaves)
        const values = commitments.map((commitment) => checkCommitment(commitment, this.scheme))

        if (values.some((value) => existing.has(value))) {
            throw new Error("IssuerRegistry: the commitment is already an approved issuer")
        }

        if (new Set(values).size !== values.length) {
            throw new Error("IssuerRegistry: the batch has a duplicate commitment")
        }

        this.leanIMT.insertMany(values)
    }

    /** Zeroes the issuer's leaf. */
    public removeIssuer(commitment: BigNumberish): void {
        this.leanIMT.update(this.requireIndexOf(commitment), 0n)
    }

    /** Replaces an approved commitment in place. */
    public updateIssuerCommitment(oldCommitment: BigNumberish, newCommitment: BigNumberish): void {
        const index = this.requireIndexOf(oldCommitment)

        this.leanIMT.update(index, this.checkNew(newCommitment))
    }

    public generateProof(commitment: BigNumberish): IssuerProof {
        return this.leanIMT.generateProof(this.requireIndexOf(commitment))
    }

    /** Verifies a proof of one of this registry's issuers against its current root. */
    public verifyProof(proof: IssuerProof): boolean {
        return (
            proof.root === this.root && this.leanIMT.has(proof.leaf) && IssuerRegistry.verifyProof(proof, this.scheme)
        )
    }

    /**
     * Verifies a proof against the root it carries, which the caller must check
     * independently. It does not bind the path length, so an internal node
     * passes as a leaf: only use it with a leaf you derived yourself.
     */
    public static verifyProof(proof: IssuerProof, scheme: IssuerScheme = poseidonScheme): boolean {
        // A removed issuer's zero leaf is still in the tree, and a hash that reduces its inputs would accept `x + bound`.
        const inRange = (value: bigint) => value >= 0n && value < scheme.bound

        return (
            proof.leaf !== 0n &&
            inRange(proof.leaf) &&
            proof.siblings.every(inRange) &&
            LeanIMT.verifyProof(proof, scheme.hash)
        )
    }

    /** The siblings the contract's `removeIssuer` and `updateIssuerCommitment` take. */
    public siblingNodesOf(commitment: BigNumberish): bigint[] {
        return this.generateProof(commitment).siblings
    }

    public export(): string {
        return this.leanIMT.export()
    }

    /**
     * @param validate Rehash the tree from its leaves. Pass `false` only for snapshots you produced.
     * @param scheme The snapshot's scheme, which it does not record.
     */
    public static import(snapshot: string, validate = true, scheme: IssuerScheme = poseidonScheme): IssuerRegistry {
        if (validate) {
            const nodes: unknown = JSON.parse(snapshot)

            if (!Array.isArray(nodes) || nodes.length === 0 || !nodes.every(Array.isArray)) {
                throw new Error("IssuerRegistry: the snapshot is not a list of tree levels")
            }
        }

        const tree = new IssuerRegistry([], scheme)

        tree.leanIMT = LeanIMT.import(scheme.hash, snapshot)

        if (validate && IssuerRegistry.fromLeaves(tree.leaves, scheme).export() !== tree.export()) {
            throw new Error("IssuerRegistry: the snapshot's nodes do not match its leaves")
        }

        return tree
    }

    /** Rebuilds any registry from its {@link leaves} or the contract's `getLeaf`. */
    public static fromLeaves(leaves: BigNumberish[], scheme: IssuerScheme = poseidonScheme): IssuerRegistry {
        const values = leaves.map((leaf) => checkFieldElement(leaf, scheme))
        const commitments = values.filter((value) => value !== 0n)

        if (new Set(commitments).size !== commitments.length) {
            throw new Error("IssuerRegistry: the leaves have a duplicate commitment")
        }

        const tree = new IssuerRegistry([], scheme)

        tree.leanIMT = new LeanIMT(scheme.hash, values)

        return tree
    }

    private checkNew(commitment: BigNumberish): bigint {
        const value = checkCommitment(commitment, this.scheme)

        if (this.leanIMT.has(value)) {
            throw new Error("IssuerRegistry: the commitment is already an approved issuer")
        }

        return value
    }

    private requireIndexOf(commitment: BigNumberish): number {
        const index = this.indexOf(commitment)

        if (index === -1) {
            throw new Error("IssuerRegistry: the commitment is not an approved issuer")
        }

        return index
    }
}
