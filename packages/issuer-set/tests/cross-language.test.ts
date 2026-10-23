import { describe, expect, it } from "@jest/globals"
import { Base8, mulPointEscalar } from "@zk-kit/baby-jubjub"
import { ApprovedIssuerSet, issuerKeyLeaf } from "../src"
import type { IssuerPublicKey } from "../src"

/**
 * The other half of the cross-language check. The same constants are asserted on chain in
 * `packages/contracts/test/integration/IssuerSetCrossLanguageRoot.t.sol`.
 *
 * An issuer builds the Merkle path it ships with a credential against a set it holds locally, and the
 * circuit opens that path against a root the verifier read from the contract. If the two
 * implementations drift apart on the leaf formula, a hash or an insertion order, every honest proof
 * silently stops verifying, so both sides pin the same numbers.
 */

/** `k * Base8`, the same points the Solidity fixture uses. */
function key(k: number): IssuerPublicKey {
    return mulPointEscalar(Base8, BigInt(k)) as IssuerPublicKey
}

const LEAF_OF_KEY_1 = 2493720610778676091149258492386261697559719708118160248500693563612404203088n
const LEAF_OF_KEY_2 = 15278273562238927018842798161288898682472598529198791544673021966310311323458n
const LEAF_OF_KEY_3 = 20980331097734099105425623618460522669974741732319895218846623662978431137317n
const LEAF_OF_KEY_4 = 21705905656914304185295122917723637117393418696030270164434565587084432601809n

describe("cross-language leaf formula", () => {
    it("matches the contract for the first four curve points", () => {
        expect(issuerKeyLeaf(key(1))).toBe(LEAF_OF_KEY_1)
        expect(issuerKeyLeaf(key(2))).toBe(LEAF_OF_KEY_2)
        expect(issuerKeyLeaf(key(3))).toBe(LEAF_OF_KEY_3)
        expect(issuerKeyLeaf(key(4))).toBe(LEAF_OF_KEY_4)
    })
})

describe("cross-language roots", () => {
    it("matches the contract for a single-key set", () => {
        const set = new ApprovedIssuerSet([key(1)])

        expect(set.root).toBe(LEAF_OF_KEY_1)
        expect(set.leafCount).toBe(1)
        expect(set.size).toBe(1)
    })

    it("matches the contract for an ascending publication order", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3)])

        expect(set.root).toBe(11334223563046274794300795549267186709638286758254539923752495560734019145426n)
        expect(set.leafCount).toBe(3)
        expect(set.size).toBe(3)
    })

    it("matches the contract for an unsorted publication order", () => {
        const set = new ApprovedIssuerSet([key(3), key(1), key(2)])

        expect(set.root).toBe(19151300757586441447950951079620367437600225804389189723287235409324606653618n)
        expect(set.leafCount).toBe(3)
        expect(set.size).toBe(3)
    })

    /**
     * The retired case is where the two implementations could most easily drift: the slot keeps its
     * Merkle position and becomes a tombstone, so both sides must agree that it stays and what it
     * hashes to. Compacting it away would leave an insert-only test passing while this one diverged.
     * `leafCount` staying at 3 while `size` drops to 2 is the tombstoned-slot claim made concrete.
     */
    it("matches the contract after a key is retired", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3)])

        set.retire(key(2))

        expect(set.root).toBe(4921528729523953824803337490802147335860663132560737848377577065829307539585n)
        expect(set.leafCount).toBe(3)
        expect(set.size).toBe(2)
    })

    /**
     * The case most likely to drift after a retirement: the retired slot keeps its physical position,
     * but a key published afterwards must land at a genuinely new slot rather than overwrite it.
     */
    it("matches the contract for retiring a key and then publishing a new one", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3)])

        set.retire(key(2))
        set.publish(key(4))

        expect(set.root).toBe(18609692274362379486848381297725279489306969837289908491222007329277316495858n)
        expect(set.leafCount).toBe(4)
        expect(set.size).toBe(3)
        expect(set.leafSlots).toEqual([LEAF_OF_KEY_1, 0n, LEAF_OF_KEY_3, LEAF_OF_KEY_4])
    })
})

describe("cross-language drained set", () => {
    /**
     * Retiring every key and republishing pins `leafCount` alongside the root. LeanIMT's monotone
     * `leafCount` means a root can no longer recur short of a hash collision (see
     * `ApprovedIssuerSet.sol`'s `_claimRoot`), so this also confirms key 4 lands at physical index 3 —
     * a fresh, append-only slot, never a tombstone overwritten in place.
     */
    it("matches the contract after every key is retired and one is published again", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3)])

        set.retire(key(1))
        set.retire(key(2))
        set.retire(key(3))
        set.publish(key(4))

        expect(set.root).toBe(15447481651925056742012518097225990020363594456890832015039600388941310964414n)
        expect(set.leafCount).toBe(4)
        expect(set.size).toBe(1)
        expect(set.leafSlots).toEqual([0n, 0n, 0n, LEAF_OF_KEY_4])
    })
})

describe("cross-language witnesses", () => {
    /**
     * The same six witnesses are asserted from Solidity's `siblingsOf` in
     * `packages/contracts/test/integration/IssuerSetCrossLanguageRoot.t.sol`. A drift in either
     * implementation's promotion or packed-index logic fails a test in both.
     */

    it("key 5 (slot 4) of [L1..L5]: one sibling, the four-key subtree root, packed index 1", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3), key(4), key(5)])
        const proof = set.generateProof(key(5))

        expect(proof.leafIndex).toBe(4)
        expect(proof.pathIndex).toBe(1)
        expect(proof.siblings).toEqual([1012468898015973113393162930052218519362020364191895474978289263522471748684n])
        expect(proof.indices).toEqual([true])
    })

    it("slot 3 of the retire-then-publish history [L1, 0, L3, L4]: two siblings, packed index 3", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3)])
        set.retire(key(2))
        set.publish(key(4))

        const proof = set.generateProof(key(4))

        expect(proof.leafIndex).toBe(3)
        expect(proof.pathIndex).toBe(3)
        expect(proof.siblings).toEqual([
            LEAF_OF_KEY_3,
            16061459657346176614393685069951559962608431786189096369621293655922039686447n
        ])
        expect(proof.indices).toEqual([true, true])
    })

    it("key 1 (slot 0) of [L1]: no siblings, packed index 0", () => {
        const set = new ApprovedIssuerSet([key(1)])
        const proof = set.generateProof(key(1))

        expect(proof.leafIndex).toBe(0)
        expect(proof.pathIndex).toBe(0)
        expect(proof.siblings).toEqual([])
        expect(proof.indices).toEqual([])
    })

    it("key 2 (slot 1) of [L1, L2, L3]: two siblings, packed index 1", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3)])
        const proof = set.generateProof(key(2))

        expect(proof.leafIndex).toBe(1)
        expect(proof.pathIndex).toBe(1)
        expect(proof.siblings).toEqual([LEAF_OF_KEY_1, LEAF_OF_KEY_3])
        expect(proof.indices).toEqual([true, false])
    })

    /**
     * Tombstone siblings, once key 2 is retired: key 1's sibling at level 0 is the tombstone itself, a
     * live 0 rather than a promoted skip, and key 3's sibling one level up is the two-slot root that
     * tombstone folds into. The same witnesses are pinned from Solidity's `siblingsOf` in
     * `IssuerSetCrossLanguageRoot.t.sol`'s `test_siblingsOfMatchesTypeScriptForTombstoneSiblings`.
     */
    it("key 1 and key 3 of [L1, retired L2, L3]: tombstone siblings", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3)])
        set.retire(key(2))

        const proofKey1 = set.generateProof(key(1))
        expect(proofKey1.leafIndex).toBe(0)
        expect(proofKey1.pathIndex).toBe(0)
        expect(proofKey1.siblings).toEqual([0n, LEAF_OF_KEY_3])
        expect(proofKey1.indices).toEqual([false, false])

        const proofKey3 = set.generateProof(key(3))
        expect(proofKey3.leafIndex).toBe(2)
        expect(proofKey3.pathIndex).toBe(1)
        expect(proofKey3.siblings).toEqual([
            16061459657346176614393685069951559962608431786189096369621293655922039686447n
        ])
        expect(proofKey3.indices).toEqual([true])
    })
})

describe("cross-language slot table", () => {
    /**
     * The slot table is the rebuild path the contract's `getLeaf`/`getLeaves` promise: a wallet reads
     * every slot and reconstructs the set with `fromLeaves`. That only works if both sides agree on
     * which commitment lands in which slot.
     */
    it("matches the contract after a key is retired", () => {
        const set = new ApprovedIssuerSet([key(1), key(2), key(3)])

        set.retire(key(2))

        expect(set.leafSlots).toEqual([LEAF_OF_KEY_1, 0n, LEAF_OF_KEY_3])

        // The tombstoned slot is still there: the leaf count did not shrink with the retirement.
        expect(set.leafSlots).toHaveLength(3)
        expect(set.size).toBe(2)
    })
})
