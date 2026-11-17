import { LeanIMTPlus } from "@zk-kit/lean-imt-plus"
import { PROOF_TYPE, SENTINEL_INDEX, SNAPSHOT_VERSION, TAG_LEAF } from "./constants"
import { poseidonScheme } from "./schemes/poseidon"
import type { BigNumberish, RevocationLeaf, RevocationProof, RevocationScheme } from "./types"
import { checkCommitment, checkFieldElement } from "./utils"

/**
 * A revocation registry: a
 * {@link https://pse.dev/blog/lean-imt-plus-efficient-merkle-tree-for-membership-and-non-membership-proofs | LeanIMT+}
 * whose leaves are revoked credential commitments. A non-membership proof shows
 * a credential is not revoked.
 *
 * Generic in its hash: the {@link RevocationScheme} (Poseidon over BN254 by
 * default) is fixed at creation and must match the authority's. A mirrored copy
 * is trusted for availability only: compare {@link root} with the authority's
 * root before using its proofs.
 */
export class RevocationRegistry {
    public leanIMTPlus: LeanIMTPlus<bigint>

    public readonly scheme: RevocationScheme

    /**
     * Commitments must be in the authority's insertion order, since the order
     * changes the root. Once anything has been un-revoked, rebuild with
     * {@link fromLeaves} or {@link import} instead: tombstones keep their slots.
     *
     * @param commitments Revoked commitments, in insertion order.
     * @param scheme Defaults to {@link poseidonScheme}.
     */
    constructor(commitments: BigNumberish[] = [], scheme: RevocationScheme = poseidonScheme) {
        this.scheme = scheme
        this.leanIMTPlus = new LeanIMTPlus(
            scheme.hashes,
            commitments.map((commitment) => checkCommitment(commitment, scheme))
        )
    }

    /** `0` while the registry is empty. */
    public get root(): bigint {
        return this.leanIMTPlus.root ?? 0n
    }

    public get depth(): number {
        return this.leanIMTPlus.depth
    }

    /** The number of revoked commitments, excluding the sentinel and tombstones. */
    public get size(): number {
        return this.leanIMTPlus.size
    }

    /** The revoked leaves in insertion order. */
    public get leaves(): RevocationLeaf[] {
        return this.leanIMTPlus.leaves
    }

    /** The revoked commitments in insertion order. Lossy: see {@link leafSlots}. */
    public get commitments(): bigint[] {
        return this.leanIMTPlus.leaves.map((leaf) => leaf.value)
    }

    /**
     * Every physical slot in index order, sentinel and tombstones included: the
     * input to {@link fromLeaves}, matching the contract's `getLeaf`. Walks the
     * whole tree.
     */
    public get leafSlots(): RevocationLeaf[] {
        const { leaves } = JSON.parse(this.export()) as { leaves: { value: string; nextValue: string }[] }

        return leaves.map(({ value, nextValue }) => ({ value: BigInt(value), nextValue: BigInt(nextValue) }))
    }

    public isRevoked(commitment: BigNumberish): boolean {
        return this.leanIMTPlus.has(checkCommitment(commitment, this.scheme))
    }

    /** The physical slot of a revoked commitment (not its position in {@link commitments}), or `-1`. */
    public indexOf(commitment: BigNumberish): number {
        return this.leanIMTPlus.indexOf(checkCommitment(commitment, this.scheme))
    }

    public revoke(commitment: BigNumberish): void {
        this.leanIMTPlus.insert(checkCommitment(commitment, this.scheme))
    }

    /** Not transactional: commitments before a rejected one stay revoked. */
    public revokeMany(commitments: BigNumberish[]): void {
        this.leanIMTPlus.insertMany(commitments.map((commitment) => checkCommitment(commitment, this.scheme)))
    }

    /**
     * Tombstones the commitment's slot. The credential becomes valid again for
     * every verifier still accepting an older root.
     */
    public unrevoke(commitment: BigNumberish): void {
        this.leanIMTPlus.remove(checkCommitment(commitment, this.scheme))
    }

    /** Replaces a revoked commitment in place, reusing its slot. */
    public updateCommitment(oldCommitment: BigNumberish, newCommitment: BigNumberish): void {
        this.leanIMTPlus.update(
            checkCommitment(oldCommitment, this.scheme),
            checkCommitment(newCommitment, this.scheme)
        )
    }

    /**
     * A non-membership proof (`proofType: 1`) if the commitment is not revoked,
     * a membership proof (`proofType: 0`) if it is.
     */
    public generateProof(commitment: BigNumberish): RevocationProof {
        if (this.root === 0n) {
            throw new Error("RevocationRegistry: cannot generate a proof against an empty registry")
        }

        return this.leanIMTPlus.generateProof(checkCommitment(commitment, this.scheme))
    }

    /** Verifies a proof against this registry's current root. */
    public verifyProof(proof: RevocationProof): boolean {
        return proof.root === this.root && this.leanIMTPlus.verifyProof(proof)
    }

    /**
     * Verifies a proof against the root it carries. That root is caller-supplied,
     * so also check it against a root you independently accept.
     *
     * @param scheme Defaults to {@link poseidonScheme}.
     */
    public static verifyProof(proof: RevocationProof, scheme: RevocationScheme = poseidonScheme): boolean {
        return LeanIMTPlus.verifyProof(proof, scheme.hashes)
    }

    /**
     * The physical index of the commitment's predecessor, for backends such as
     * the contract that validate it instead of searching. Only valid against the
     * current state.
     *
     * @returns `0` (the sentinel) for the first revocation.
     */
    public lowLeafIndexOf(commitment: BigNumberish): number {
        const value = checkCommitment(commitment, this.scheme)

        if (this.root === 0n) {
            return SENTINEL_INDEX
        }

        const proof = this.leanIMTPlus.generateProof(value)

        if (proof.proofType === PROOF_TYPE.MEMBERSHIP) {
            throw new Error("RevocationRegistry: the commitment has already been revoked")
        }

        // `proof.leafIndex` is the compacted Merkle path, not the physical slot.
        return proof.leaf.value === 0n ? SENTINEL_INDEX : this.leanIMTPlus.indexOf(proof.leaf.value)
    }

    /**
     * Low leaf indices for a batched write: index `i` is computed after
     * commitments `0..i-1` are inserted. Leaves this registry untouched.
     */
    public lowLeafIndicesOf(commitments: BigNumberish[]): number[] {
        const scratch = RevocationRegistry.import(this.export(), false, this.scheme)

        return commitments.map((commitment) => {
            const index = scratch.lowLeafIndexOf(commitment)
            scratch.revoke(commitment)
            return index
        })
    }

    /** The physical index of a revoked commitment's predecessor, for un-revoking or replacing it. */
    public predecessorIndexOf(commitment: BigNumberish): number {
        const value = checkCommitment(commitment, this.scheme)

        if (!this.leanIMTPlus.has(value)) {
            throw new Error("RevocationRegistry: the commitment has not been revoked")
        }

        const predecessor = this.leanIMTPlus.leaves.find((leaf) => leaf.nextValue === value)

        return predecessor === undefined ? SENTINEL_INDEX : this.leanIMTPlus.indexOf(predecessor.value)
    }

    /** Serializes the whole tree, hashes included. */
    public export(): string {
        return this.leanIMTPlus.export()
    }

    /**
     * Rebuilds a registry from {@link export} output.
     *
     * @param validate Rehash the leaves and range-check every value, rejecting a
     * tampered snapshot. Pass `false` only for snapshots you produced.
     * @param scheme The snapshot's scheme, which it does not record. Defaults to
     * {@link poseidonScheme}.
     */
    public static import(
        snapshot: string,
        validate = true,
        scheme: RevocationScheme = poseidonScheme
    ): RevocationRegistry {
        const tree = new RevocationRegistry([], scheme)

        tree.leanIMTPlus = LeanIMTPlus.import(scheme.hashes, snapshot, { validate })

        // A hash that reduces mod p would accept a leaf holding `c + p` under the honest root,
        // while `isRevoked(c)` is false.
        if (validate) {
            for (const { value, nextValue } of tree.leafSlots) {
                checkFieldElement(value, scheme)
                checkFieldElement(nextValue, scheme)
            }
        }

        return tree
    }

    /**
     * Rebuilds any registry, tombstones included, from its physical slots
     * ({@link leafSlots}, or the contract's `getLeaf`). Every hash is
     * recomputed; compare {@link root} with the authority's to catch missing or
     * reordered slots.
     *
     * @param scheme Defaults to {@link poseidonScheme}.
     */
    public static fromLeaves(
        leaves: { value: BigNumberish; nextValue: BigNumberish }[],
        scheme: RevocationScheme = poseidonScheme
    ): RevocationRegistry {
        if (leaves.length === 0) {
            return new RevocationRegistry([], scheme)
        }

        const records = leaves.map(({ value, nextValue }) => ({
            value: checkFieldElement(value, scheme),
            nextValue: checkFieldElement(nextValue, scheme)
        }))

        if (records[0].value !== 0n) {
            throw new Error("RevocationRegistry: the leaf at index 0 must be the sentinel, whose value is zero")
        }

        // LeanIMT promotes an unpaired node unchanged.
        const nodes: bigint[][] = [records.map((leaf) => scheme.hashes.leaf(leaf.value, leaf.nextValue, TAG_LEAF))]

        while (nodes[nodes.length - 1].length > 1) {
            const level = nodes[nodes.length - 1]
            const parents: bigint[] = []

            for (let i = 0; i < level.length; i += 2) {
                parents.push(i + 1 < level.length ? scheme.hashes.internal(level[i], level[i + 1]) : level[i])
            }

            nodes.push(parents)
        }

        const snapshot = JSON.stringify({
            version: SNAPSHOT_VERSION,
            nodes: nodes.map((level) => level.map(String)),
            leaves: records.map(({ value, nextValue }) => ({
                value: value.toString(),
                nextValue: nextValue.toString()
            }))
        })

        // The nodes were just derived from the leaves, so validating them again would be circular.
        return RevocationRegistry.import(snapshot, false, scheme)
    }
}
