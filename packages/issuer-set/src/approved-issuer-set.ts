import { LeanIMT } from "@zk-kit/lean-imt"
import { ISSUER_SET_MAX_DEPTH } from "./constants"
import { internalNode, issuerKeyLeaf } from "./hashes"
import type { BigNumberish, ContractLeafReader, IssuerMembershipWitness, IssuerPublicKey, IssuerSet } from "./types"
import { toFieldElement, toPublicKey } from "./utils"

/** How many leaves {@link ApprovedIssuerSet.fromContract} requests per `getLeaves` call. */
const FROM_CONTRACT_PAGE_SIZE = 1000

/**
 * The approved-issuer set: a LeanIMT accumulator, capped at depth
 * {@link ISSUER_SET_MAX_DEPTH}, over network members' credential signing keys
 * spec 03 defines, mirroring `ApprovedIssuerSet.sol`.
 *
 * A retired key's slot is tombstoned to `0` rather than removed, the same
 * dense, append-only storage the contract keeps: `leafCount` never shrinks, so
 * a slot's Merkle position never changes once assigned. A node with no right
 * sibling is promoted unchanged rather than hashed against a zero, so the
 * tree's depth tracks `ceil(log2(leafCount))` instead of staying fixed.
 */
export class ApprovedIssuerSet implements IssuerSet {
    private tree: LeanIMT<bigint>

    /**
     * @param publicKeys The set's current signing keys, in order. Not
     * curve-validated: this bulk-load path mirrors an already-validated
     * on-chain state, unlike {@link publish}.
     */
    constructor(publicKeys: IssuerPublicKey[]) {
        if (publicKeys.length === 0) throw new Error("approved issuer set must not be empty")
        if (publicKeys.length > 2 ** ISSUER_SET_MAX_DEPTH) {
            throw new Error("approved issuer set exceeds circuit capacity")
        }

        const leaves = publicKeys.map(issuerKeyLeaf)
        // Compared as leaves, not as coordinate pairs, so this agrees with `publish`'s own check.
        if (new Set(leaves).size !== leaves.length) {
            throw new Error("approved issuer set contains a duplicate key")
        }

        this.tree = new LeanIMT<bigint>(internalNode, leaves)
    }

    /** The current root. Never `undefined`: both constructors require at least one slot. */
    get root(): bigint {
        return this.tree.root
    }

    /** The number of physical leaf slots, including tombstoned ones. Never decreases. */
    get leafCount(): number {
        return this.tree.size
    }

    /** The number of currently approved (non-tombstoned) keys. */
    get size(): number {
        return this.tree.leaves.filter((leaf) => leaf !== 0n).length
    }

    /** `ceil(log2(leafCount))`, 0 for a one-slot set. Grows as slots are added; never shrinks. */
    get depth(): number {
        return this.tree.depth
    }

    /** Every physical slot, in order, `0` for a tombstone. A copy: mutate through {@link publish}/{@link retire}. */
    get leafSlots(): bigint[] {
        return this.tree.leaves
    }

    /** The leaf a key would occupy, without publishing it. */
    static leafOf(publicKey: IssuerPublicKey): bigint {
        return issuerKeyLeaf(toPublicKey(publicKey))
    }

    /**
     * Rebuilds a set from the physical slot table a holder reads with
     * `ApprovedIssuerSet.getLeaves` — the private path that never asks the
     * chain which leaf it holds a witness for (see the contract's
     * `siblingsOf` natspec).
     *
     * @param leaves Every slot, in physical order, `0` for a tombstone.
     * @throws if `leaves` is empty. A drained set (every slot tombstoned) is
     * a valid, nonzero-length input; the on-chain analogue is `leafCount`
     * being monotonic, so a set that has ever published a key is never truly
     * empty again.
     */
    static fromLeaves(leaves: BigNumberish[]): ApprovedIssuerSet {
        if (leaves.length === 0) throw new Error("approved issuer set must not be empty")

        // Bypasses the public constructor, which validates a list of public keys: these are already
        // leaf hashes, not keys, mirroring a state the caller trusts (the contract's own storage).
        const set = Object.create(ApprovedIssuerSet.prototype) as ApprovedIssuerSet

        set.tree = new LeanIMT<bigint>(internalNode, leaves.map(toFieldElement))

        return set
    }

    /**
     * Rebuilds a set from a deployed `ApprovedIssuerSet.sol`, paging through
     * `getLeaves` so a large set never needs one unbounded call. Pages are
     * fetched concurrently — the reader isn't block-pinned, so this is no
     * weaker a read than the sequential form.
     */
    static async fromContract(reader: ContractLeafReader): Promise<ApprovedIssuerSet> {
        const leafCount = Number(await reader.getLeafCount())

        const ranges: [number, number][] = []
        for (let start = 0; start < leafCount; start += FROM_CONTRACT_PAGE_SIZE) {
            ranges.push([start, Math.min(start + FROM_CONTRACT_PAGE_SIZE, leafCount)])
        }

        const pages = await Promise.all(ranges.map(([start, end]) => reader.getLeaves(start, end)))

        return ApprovedIssuerSet.fromLeaves(pages.flat())
    }

    /** Whether a witness is internally consistent with the root it carries, independent of any set. */
    static verifyProof(proof: IssuerMembershipWitness): boolean {
        if (proof.indices.length !== proof.siblings.length) return false

        let packed = 0
        for (let level = 0; level < proof.indices.length; level += 1) {
            if (proof.indices[level]) packed |= 1 << level
        }
        if (packed !== proof.pathIndex) return false

        return LeanIMT.verifyProof(
            { root: proof.root, leaf: proof.leaf, index: proof.pathIndex, siblings: proof.siblings },
            internalNode
        )
    }

    /** Whether a signing key is currently approved. */
    isApproved(publicKey: IssuerPublicKey): boolean {
        return this.indexOf(publicKey) >= 0
    }

    /** The physical index of a currently approved key, or `-1`. */
    indexOf(publicKey: IssuerPublicKey): number {
        return this.tree.indexOf(issuerKeyLeaf(publicKey))
    }

    /**
     * Publishes a signing key, appended at the next free slot.
     * @returns The leaf commitment inserted.
     * @throws if the key is off-curve, not in the prime-order subgroup, or already approved.
     */
    publish(publicKey: IssuerPublicKey): bigint {
        const leaf = issuerKeyLeaf(toPublicKey(publicKey))

        if (this.tree.has(leaf)) {
            throw new Error("approved issuer set contains a duplicate key")
        }

        this.tree.insert(leaf)

        return leaf
    }

    /**
     * {@link publish}, for several keys in order. Each is checked against the
     * ones already in this batch too, and the set is rebuilt once at the end
     * rather than after every key.
     * @throws if any key is invalid or a duplicate, leaving the set unchanged.
     */
    publishMany(publicKeys: IssuerPublicKey[]): bigint[] {
        if (publicKeys.length === 0) return []

        const leaves: bigint[] = []

        for (const publicKey of publicKeys) {
            const leaf = issuerKeyLeaf(toPublicKey(publicKey))

            if (this.tree.has(leaf) || leaves.includes(leaf)) {
                throw new Error("approved issuer set contains a duplicate key")
            }

            leaves.push(leaf)
        }

        this.tree.insertMany(leaves)

        return leaves
    }

    /**
     * Tombstones a key's slot to `0`, ending its ability to verify. The slot
     * stays allocated; a republished key gets a new one.
     * @throws if the key is off-curve, not in the prime-order subgroup, or not currently approved.
     */
    retire(publicKey: IssuerPublicKey): void {
        const index = this.indexOf(toPublicKey(publicKey))
        if (index < 0) throw new Error("credential issuer is not in the approved set")

        this.tree.update(index, 0n)
    }

    /**
     * Generates the membership witness the credential circuit consumes.
     * @throws if the key is off-curve, not in the prime-order subgroup, or not currently approved.
     */
    generateProof(publicKey: IssuerPublicKey): IssuerMembershipWitness {
        const leaf = issuerKeyLeaf(toPublicKey(publicKey))
        const leafIndex = this.tree.indexOf(leaf)
        if (leafIndex < 0) throw new Error("credential issuer is not in the approved set")

        const proof = this.tree.generateProof(leafIndex)
        const indices = Array.from({ length: proof.siblings.length }, (_, level) => ((proof.index >> level) & 1) === 1)

        return { root: this.root, leafIndex, pathIndex: proof.index, siblings: proof.siblings, indices, leaf }
    }

    /** Instance form of {@link ApprovedIssuerSet.verifyProof}, additionally bound to this set's current root. */
    verifyProof(proof: IssuerMembershipWitness): boolean {
        return proof.root === this.root && ApprovedIssuerSet.verifyProof(proof)
    }
}
