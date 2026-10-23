import { LeanIMTPlus } from "@zk-kit/lean-imt-plus"
import { PROOF_TYPE, SENTINEL_INDEX, SNAPSHOT_VERSION, TAG_LEAF } from "./constants"
import { revocationHashes } from "./hashes"
import type { BigNumberish, RevocationLeaf, RevocationProof } from "./types"
import { toCommitment, toFieldElement } from "./utils"

/**
 * A revocation registry: a
 * {@link https://pse.dev/blog/lean-imt-plus-efficient-merkle-tree-for-membership-and-non-membership-proofs | LeanIMT+}
 * whose leaves are the revocation commitments of revoked credentials.
 *
 * The class is a self-contained implementation of the structure, not a client
 * for any particular backend. It can hold a registry outright, which is what a
 * service that publishes revocations from its own database does, or mirror one
 * whose authoritative copy lives elsewhere, which is what a holder does before
 * building a proof. Nothing here reads or writes anything external.
 *
 * Two operations serve the two roles:
 *
 * - **Issuer.** {@link revoke} inserts a commitment. Where the authoritative
 *   registry is a separate system that validates a predecessor index rather than
 *   searching for one, {@link lowLeafIndexOf} computes that index.
 * - **Holder.** {@link generateProof} produces a proof about a commitment. A
 *   non-membership proof (`proofType: 1`) is what shows a credential is not
 *   revoked, and is the witness a zero-knowledge circuit consumes to show it
 *   without revealing the commitment.
 *
 * When this instance is a mirror rather than the authority, it is trusted for
 * availability only, never for integrity: compare {@link root} against the root
 * the authority reports before using any proof built from it. Building the tree
 * locally is also what keeps a holder private, since they read the whole public
 * registry and never disclose which commitment they care about.
 *
 * An empty registry has a root of `0` and cannot produce proofs: nothing has
 * been revoked yet, so there is nothing to prove against. Verifiers must handle
 * that case as "no revocations", not as a failure.
 */
export class RevocationRegistry {
    /** The underlying LeanIMT+ instance. */
    public leanIMTPlus: LeanIMTPlus<bigint>

    /**
     * Creates a registry, optionally pre-loaded with revoked commitments.
     * Passing the full list is more efficient than revoking them one by one,
     * because each affected internal node is rehashed at most once.
     *
     * The tree is position-addressable, so a different insertion order produces
     * a different root even for the same set of commitments. When rebuilding a
     * registry that already exists elsewhere, the commitments must be supplied
     * in the order that registry inserted them.
     *
     * This reconstructs a registry only while nothing has ever been un-revoked.
     * An un-revocation leaves a tombstoned slot behind, and that slot still
     * occupies a Merkle position, so replaying the surviving commitments would
     * produce a different root. Use {@link RevocationRegistry.fromLeaves} or
     * {@link RevocationRegistry.import} for a registry that may have tombstones.
     *
     * @param commitments Revoked commitments, in insertion order.
     */
    constructor(commitments: BigNumberish[] = []) {
        this.leanIMTPlus = new LeanIMTPlus(revocationHashes, commitments.map(toCommitment))
    }

    /** The current revocation root. `0` while the registry is empty. */
    public get root(): bigint {
        return this.leanIMTPlus.root ?? 0n
    }

    /** The current tree depth. */
    public get depth(): number {
        return this.leanIMTPlus.depth
    }

    /** The number of revoked commitments, excluding the sentinel and tombstones. */
    public get size(): number {
        return this.leanIMTPlus.size
    }

    /**
     * The revoked commitments in insertion order. Reading `.value` off each leaf
     * gives the commitments; `.nextValue` exposes the sorted linked list the
     * non-membership proof relies on.
     */
    public get leaves(): RevocationLeaf[] {
        return this.leanIMTPlus.leaves
    }

    /**
     * The revoked commitments, in insertion order. Excludes the sentinel and any
     * tombstones, so this is a lossy view of the tree: it round-trips through the
     * constructor only while nothing has been un-revoked. See
     * {@link leafSlots}.
     */
    public get commitments(): bigint[] {
        return this.leanIMTPlus.leaves.map((leaf) => leaf.value)
    }

    /**
     * Every physical leaf slot in index order, sentinel and tombstones included.
     *
     * This is the lossless view of the registry and the counterpart of
     * {@link RevocationRegistry.fromLeaves}: an authority publishes these slots,
     * and anyone can rebuild the exact same tree from them. It mirrors what the
     * on-chain registry exposes through `getLeaf`.
     *
     * Prefer {@link commitments} to enumerate what is revoked. This walks the
     * whole tree, so treat it as a publishing operation rather than a hot path.
     */
    public get leafSlots(): RevocationLeaf[] {
        const { leaves } = JSON.parse(this.export()) as { leaves: { value: string; nextValue: string }[] }

        return leaves.map(({ value, nextValue }) => ({ value: BigInt(value), nextValue: BigInt(nextValue) }))
    }

    /** Returns true if the commitment has been revoked. */
    public isRevoked(commitment: BigNumberish): boolean {
        return this.leanIMTPlus.has(toCommitment(commitment))
    }

    /**
     * Returns the physical leaf index of a revoked commitment, or `-1` if it is
     * not revoked.
     *
     * This is a slot in the tree, never a position in {@link commitments}. The
     * two always differ by at least one, because slot 0 is the sentinel, and
     * they drift further apart with every tombstone.
     */
    public indexOf(commitment: BigNumberish): number {
        return this.leanIMTPlus.indexOf(toCommitment(commitment))
    }

    /**
     * Revokes a credential by inserting its commitment.
     *
     * @param commitment The revocation commitment of the credential.
     */
    public revoke(commitment: BigNumberish): void {
        this.leanIMTPlus.insert(toCommitment(commitment))
    }

    /**
     * Revokes several credentials in one pass. Cheaper than calling
     * {@link revoke} once per commitment, because each affected internal node is
     * rehashed at most once.
     *
     * Not transactional: if a commitment mid-batch is rejected, the earlier ones
     * have already been applied. Validate with {@link isRevoked} first when the
     * input is untrusted.
     *
     * @param commitments The revocation commitments, in insertion order.
     */
    public revokeMany(commitments: BigNumberish[]): void {
        this.leanIMTPlus.insertMany(commitments.map(toCommitment))
    }

    /**
     * Un-revokes a credential, tombstoning its slot.
     *
     * Revocation is normally permanent, and a registry that never un-revokes is
     * the simpler thing to reason about: an un-revoked credential becomes valid
     * again for every verifier that has not yet seen the new root. The operation
     * is exposed because the underlying tree supports it and some issuers need
     * to undo a mistaken revocation, but reach for it deliberately.
     *
     * It also leaves a tombstoned slot behind, after which the registry can no
     * longer be rebuilt from {@link commitments} alone. Publish the leaf slots
     * (see {@link RevocationRegistry.fromLeaves}) or a snapshot instead.
     *
     * @param commitment The revocation commitment to un-revoke.
     */
    public unrevoke(commitment: BigNumberish): void {
        this.leanIMTPlus.remove(toCommitment(commitment))
    }

    /**
     * Replaces a revoked commitment with another one, in place, reusing the old
     * physical slot. Cheaper than an {@link unrevoke} followed by a
     * {@link revoke}, which would tombstone a slot and append a new one.
     *
     * @param oldCommitment The revoked commitment to replace.
     * @param newCommitment The commitment to put in its place.
     */
    public updateCommitment(oldCommitment: BigNumberish, newCommitment: BigNumberish): void {
        this.leanIMTPlus.update(toCommitment(oldCommitment), toCommitment(newCommitment))
    }

    /**
     * Generates a proof for a commitment: a non-membership proof
     * (`proofType: 1`) if the credential is not revoked, a membership proof
     * (`proofType: 0`) if it is.
     *
     * The proof carries the root it was built against. It proves nothing until
     * the verifier independently accepts that root as one the authoritative
     * registry currently publishes.
     *
     * @param commitment The revocation commitment of the credential.
     * @returns The revocation proof.
     */
    public generateProof(commitment: BigNumberish): RevocationProof {
        if (this.root === 0n) {
            throw new Error("RevocationRegistry: cannot generate a proof against an empty registry")
        }

        return this.leanIMTPlus.generateProof(toCommitment(commitment))
    }

    /**
     * Verifies a proof against this tree's current root. Use the static
     * {@link RevocationRegistry.verifyProof} to check a proof without a local tree.
     */
    public verifyProof(proof: RevocationProof): boolean {
        return proof.root === this.root && this.leanIMTPlus.verifyProof(proof)
    }

    /**
     * Verifies that a proof is internally consistent with the root it carries.
     *
     * This does not bind the proof to any registry: the caller supplies
     * `proof.root`, so on its own this returns true for a proof against an
     * attacker-chosen root. Always compare `proof.root` against a root you
     * independently accept.
     */
    public static verifyProof(proof: RevocationProof): boolean {
        return LeanIMTPlus.verifyProof(proof, revocationHashes)
    }

    /**
     * Returns the physical index of the low leaf of a commitment: the
     * predecessor a constrained implementation needs supplied rather than
     * searched for.
     *
     * {@link revoke} does not need this, since it finds the predecessor itself.
     * It exists for registries whose authoritative implementation validates a
     * caller-supplied index in O(1) instead of searching, which is how a version
     * that has to bound its own cost per write is built. Such an index is only
     * valid against the tree state the write applies to, so if another revocation
     * lands first it must be recomputed against the new state.
     *
     * @param commitment The commitment about to be revoked.
     * @returns The physical index of its predecessor, or `0` for the first
     * revocation, where the argument is ignored and the sentinel is created.
     */
    public lowLeafIndexOf(commitment: BigNumberish): number {
        const value = toCommitment(commitment)

        if (this.root === 0n) {
            return SENTINEL_INDEX
        }

        const proof = this.leanIMTPlus.generateProof(value)

        if (proof.proofType === PROOF_TYPE.MEMBERSHIP) {
            throw new Error("RevocationRegistry: the commitment has already been revoked")
        }

        // Not `proof.leafIndex`: that is the compacted Merkle path, which skips the
        // levels where the leaf's ancestor had no sibling, so it does not equal the
        // physical slot. Resolve the slot from the low leaf's value instead. A low
        // leaf holding zero is the sentinel, which always sits at index 0.
        return proof.leaf.value === 0n ? SENTINEL_INDEX : this.leanIMTPlus.indexOf(proof.leaf.value)
    }

    /**
     * Returns the low leaf indices for a batch of commitments, as a batched
     * write expects them: index `i` is computed against the tree state after
     * commitments `0..i-1` have been inserted.
     *
     * Computed on a throwaway copy, so this tree is left untouched.
     *
     * @param commitments The commitments about to be revoked, in insertion order.
     */
    public lowLeafIndicesOf(commitments: BigNumberish[]): number[] {
        const scratch = RevocationRegistry.import(this.export(), false)

        return commitments.map((commitment) => {
            const index = scratch.lowLeafIndexOf(commitment)
            scratch.revoke(commitment)
            return index
        })
    }

    /**
     * Returns the physical index of the leaf whose `nextValue` is this
     * commitment. The counterpart of {@link lowLeafIndexOf} for un-revoking and
     * for replacing a commitment.
     *
     * Returns `0` when the commitment is the smallest in the registry, because
     * the sentinel at index 0 is then its predecessor.
     *
     * @param commitment A revoked commitment.
     */
    public predecessorIndexOf(commitment: BigNumberish): number {
        const value = toCommitment(commitment)

        if (!this.leanIMTPlus.has(value)) {
            throw new Error("RevocationRegistry: the commitment has not been revoked")
        }

        const predecessor = this.leanIMTPlus.leaves.find((leaf) => leaf.nextValue === value)

        return predecessor === undefined ? SENTINEL_INDEX : this.leanIMTPlus.indexOf(predecessor.value)
    }

    /**
     * Serializes the whole tree, hashes included.
     *
     * This is the snapshot format: publishing a snapshot lets a holder rebuild a
     * large registry without replaying every revocation since genesis. A snapshot
     * is trusted for availability only, so an importing client must still compare
     * {@link root} against the root the authoritative registry publishes.
     */
    public export(): string {
        return this.leanIMTPlus.export()
    }

    /**
     * Rebuilds a tree from {@link export} output.
     *
     * @param snapshot The serialized tree.
     * @param validate Recompute every commitment and check it against the
     * serialized hashes and require every leaf value to be a field element,
     * rejecting a tampered snapshot. Defaults to `true`; pass `false` only for
     * data you produced yourself.
     */
    public static import(snapshot: string, validate = true): RevocationRegistry {
        const tree = new RevocationRegistry()

        tree.leanIMTPlus = LeanIMTPlus.import(revocationHashes, snapshot, { validate })

        // Hashing reduces mod p, so a leaf holding `c + p` matches the honest root while `isRevoked(c)` is false.
        if (validate) {
            for (const { value, nextValue } of tree.leafSlots) {
                toFieldElement(value)
                toFieldElement(nextValue)
            }
        }

        return tree
    }

    /**
     * Rebuilds a registry from its full physical leaf slots, sentinel and
     * tombstones included.
     *
     * This is the reconstruction path that always works. The constructor takes
     * only the active commitments, which is enough only while no commitment has
     * ever been un-revoked: an un-revocation leaves a tombstoned slot behind, and
     * a slot still occupies a Merkle position, so a registry that has one cannot
     * be reproduced from its commitments alone.
     *
     * The leaf slots are exactly what an authoritative registry can publish
     * verbatim: {@link leafSlots} here, or `getLeaf(registryId, i)` for `i` in
     * `0..getRevocationTreeLeafCount(registryId) - 1` on chain.
     *
     * Hashes are recomputed here rather than taken on trust, so unlike a snapshot
     * the input carries no node data to tamper with. The caller must still
     * compare {@link root} against the root the authority publishes, which is
     * what detects missing or reordered slots.
     *
     * @param leaves The physical leaf slots, in index order starting at the
     * sentinel.
     * @returns The reconstructed registry.
     */
    public static fromLeaves(leaves: { value: BigNumberish; nextValue: BigNumberish }[]): RevocationRegistry {
        if (leaves.length === 0) {
            return new RevocationRegistry()
        }

        const records = leaves.map(({ value, nextValue }) => ({
            value: toFieldElement(value),
            nextValue: toFieldElement(nextValue)
        }))

        if (records[0].value !== 0n) {
            throw new Error("RevocationRegistry: the leaf at index 0 must be the sentinel, whose value is zero")
        }

        // Rebuild every level of the LeanIMT, promoting an unpaired node unchanged.
        const nodes: bigint[][] = [records.map((leaf) => revocationHashes.leaf(leaf.value, leaf.nextValue, TAG_LEAF))]

        while (nodes[nodes.length - 1].length > 1) {
            const level = nodes[nodes.length - 1]
            const parents: bigint[] = []

            for (let i = 0; i < level.length; i += 2) {
                parents.push(i + 1 < level.length ? revocationHashes.internal(level[i], level[i + 1]) : level[i])
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

        // The node hashes were just derived from the leaves, so re-validating them
        // would be circular. Integrity comes from comparing the root to the authority.
        return RevocationRegistry.import(snapshot, false)
    }
}
