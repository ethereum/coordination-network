// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IssuerSetHashes } from "../../src/libraries/IssuerSetHashes.sol";
import { ApprovedIssuerSetTestBase } from "../utils/ApprovedIssuerSetTestBase.sol";

/// @dev Pins the contract's leaves and roots against the ones the TypeScript package produces for the
/// same keys in the same order.
///
/// This is the invariant the credential layer rests on: an issuer builds the Merkle path it ships
/// with a credential off chain, and the circuit opens that path against a root the verifier read from
/// this contract. If the two implementations ever disagree on the leaf formula, a hash or an
/// insertion order, every honest proof silently stops verifying. The same constants are asserted from
/// the TypeScript side in `packages/issuer-set/tests/cross-language.test.ts`, so a drift in either
/// implementation fails a test in both.
contract IssuerSetCrossLanguageRootTest is ApprovedIssuerSetTestBase {
    uint256 internal constant LEAF_OF_KEY_1 =
        2_493_720_610_778_676_091_149_258_492_386_261_697_559_719_708_118_160_248_500_693_563_612_404_203_088;
    uint256 internal constant LEAF_OF_KEY_2 =
        15_278_273_562_238_927_018_842_798_161_288_898_682_472_598_529_198_791_544_673_021_966_310_311_323_458;
    uint256 internal constant LEAF_OF_KEY_3 =
        20_980_331_097_734_099_105_425_623_618_460_522_669_974_741_732_319_895_218_846_623_662_978_431_137_317;
    uint256 internal constant LEAF_OF_KEY_4 =
        21_705_905_656_914_304_185_295_122_917_723_637_117_393_418_696_030_270_164_434_565_587_084_432_601_809;

    uint256 internal constant ROOT_OF_KEYS_1_2_3 =
        11_334_223_563_046_274_794_300_795_549_267_186_709_638_286_758_254_539_923_752_495_560_734_019_145_426;
    uint256 internal constant ROOT_OF_KEYS_3_1_2 =
        19_151_300_757_586_441_447_950_951_079_620_367_437_600_225_804_389_189_723_287_235_409_324_606_653_618;

    /// @dev Keys 1, 2 and 3 published in that order, then key 2 retired.
    uint256 internal constant ROOT_OF_KEYS_1_2_3_LESS_2 =
        4_921_528_729_523_953_824_803_337_490_802_147_335_860_663_132_560_737_848_377_577_065_829_307_539_585;

    /// @dev Keys 1, 2 and 3 published, all three retired, then key 4 published into the drained set.
    /// Append-only slots mean key 4 lands at physical index 3, a slot no earlier key ever occupied —
    /// there is no sentinel value for the tree to reuse or collide with.
    uint256 internal constant ROOT_AFTER_DRAIN_AND_REPUBLISH =
        15_447_481_651_925_056_742_012_518_097_225_990_020_363_594_456_890_832_015_039_600_388_941_310_964_414;

    /// @dev Boundary pins at leafCount 2^k and 2^k + 1 for k = 0..3, one member's incremental
    /// publication of keys 1 through 9. ROOT_OF_KEYS_1_TO_3 coincides with ROOT_OF_KEYS_1_2_3 above.
    uint256 internal constant ROOT_OF_KEYS_1_TO_1 =
        2_493_720_610_778_676_091_149_258_492_386_261_697_559_719_708_118_160_248_500_693_563_612_404_203_088;
    uint256 internal constant ROOT_OF_KEYS_1_TO_2 =
        15_680_708_859_485_847_685_012_924_683_010_191_875_504_585_065_894_243_099_617_821_723_863_156_328_943;
    uint256 internal constant ROOT_OF_KEYS_1_TO_4 =
        1_012_468_898_015_973_113_393_162_930_052_218_519_362_020_364_191_895_474_978_289_263_522_471_748_684;
    uint256 internal constant ROOT_OF_KEYS_1_TO_5 =
        1_509_212_439_766_155_221_370_997_401_451_147_889_947_558_708_210_956_682_611_194_460_683_115_030_117;
    uint256 internal constant ROOT_OF_KEYS_1_TO_8 =
        8_103_466_290_192_899_527_612_530_891_088_843_639_161_608_858_987_810_203_648_964_336_972_811_762_734;
    uint256 internal constant ROOT_OF_KEYS_1_TO_9 =
        13_093_761_211_208_523_070_705_799_049_763_630_755_337_080_139_718_445_220_757_699_102_900_549_412_628;

    /// @dev Witness pins, computed independently of the code under test: the same witnesses are
    /// asserted from TypeScript's `generateProof` in `packages/issuer-set/tests/cross-language.test.ts`,
    /// via `siblingsOf` here. A drift in either implementation's promotion or packed-index logic fails a
    /// test in both.
    uint256 internal constant LEAF_OF_KEY_5 =
        4_029_721_412_134_472_390_880_556_623_823_626_605_887_100_568_363_958_966_840_398_067_002_971_389_404;
    uint256 internal constant ROOT_OF_KEY_1_AND_RETIRED_KEY_2 =
        16_061_459_657_346_176_614_393_685_069_951_559_962_608_431_786_189_096_369_621_293_655_922_039_686_447;

    /// @dev The leaf formula pinned on its own. A mismatch here is far cheaper to find than one that
    /// only shows up as a diverged root.
    function test_leafFormulaMatchesTypeScript() public view {
        assertEq(IssuerSetHashes.issuerKeyLeaf(keyX[0], keyY[0]), LEAF_OF_KEY_1);
        assertEq(IssuerSetHashes.issuerKeyLeaf(keyX[1], keyY[1]), LEAF_OF_KEY_2);
        assertEq(IssuerSetHashes.issuerKeyLeaf(keyX[2], keyY[2]), LEAF_OF_KEY_3);
        assertEq(IssuerSetHashes.issuerKeyLeaf(keyX[3], keyY[3]), LEAF_OF_KEY_4);
    }

    function test_rootMatchesTypeScriptForAnAscendingPublicationOrder() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);
        _publish(memberNetworkId, 2);

        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_2_3);
        assertEq(issuerSet.getLeafCount(), 3);
        assertEq(issuerSet.getSize(), 3);
    }

    function test_rootMatchesTypeScriptForAnUnsortedPublicationOrder() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 2);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);

        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_3_1_2);
        assertEq(issuerSet.getLeafCount(), 3);
        assertEq(issuerSet.getSize(), 3);
    }

    /// @dev A retired key is the case where the two implementations could most easily drift: the slot
    /// keeps its Merkle position and becomes a tombstone, so both sides must agree that it stays and
    /// what it hashes to. If either side compacted the slot away, the roots here would diverge while
    /// a publish-only test still passed. `getLeafCount` staying at 3 while `getSize` drops to 2 is the
    /// tombstoned-slot claim made concrete: retirement zeroes the leaf without freeing the index.
    function test_rootMatchesTypeScriptAfterARetirement() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);
        _publish(memberNetworkId, 2);

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, LEAF_OF_KEY_2);

        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_2_3_LESS_2);
        assertEq(issuerSet.getLeafCount(), 3);
        assertEq(issuerSet.getSize(), 2);

        uint256[] memory values = new uint256[](3);
        values[0] = LEAF_OF_KEY_1;
        values[1] = 0;
        values[2] = LEAF_OF_KEY_3;

        for (uint256 i = 0; i < values.length; ++i) {
            assertEq(issuerSet.getLeaf(i), values[i]);
        }
        assertEq(issuerSet.getLeaves(0, 3), values);
    }

    /// @dev Draining every key and republishing is the case most worth pinning together with
    /// `leafCount`: a root can no longer recur short of a hash collision (see
    /// `ApprovedIssuerSet._claimRoot`), so the root alone is a weak proof that key 4 landed in a fresh
    /// slot rather than overwriting one of the three tombstones. Asserting `getLeafCount() == 4` and
    /// the full slot table closes that gap.
    function test_rootMatchesTypeScriptAfterADrainAndRepublish() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);
        _publish(memberNetworkId, 2);

        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);
        vm.startPrank(authAddress);
        issuerSet.retireIssuerKey(memberNetworkId, LEAF_OF_KEY_1);
        issuerSet.retireIssuerKey(memberNetworkId, LEAF_OF_KEY_2);
        issuerSet.retireIssuerKey(memberNetworkId, LEAF_OF_KEY_3);
        uint256 fourth = issuerSet.publishIssuerKey(memberNetworkId, keyX[3], keyY[3]);
        vm.stopPrank();

        assertEq(fourth, LEAF_OF_KEY_4);
        assertEq(issuerSet.issuerSetRoot(), ROOT_AFTER_DRAIN_AND_REPUBLISH);
        assertEq(issuerSet.getLeafCount(), 4);
        assertEq(issuerSet.getSize(), 1);

        uint256[] memory values = new uint256[](4);
        values[3] = LEAF_OF_KEY_4;

        for (uint256 i = 0; i < values.length; ++i) {
            assertEq(issuerSet.getLeaf(i), values[i]);
        }
        assertEq(issuerSet.getLeaves(0, 4), values);
    }

    /// @dev Pins the root at every leafCount boundary 2^k and 2^k + 1 for k = 0..3. A promoted node
    /// changes the root at exactly these widths, so this is where a depth mismatch between the two
    /// implementations would first show up. Key 9 goes through a second member since the first is at
    /// its 8-key cap after key 8.
    function test_rootMatchesTypeScriptAtEveryPowerOfTwoBoundary() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);
        address otherAuthAddress = registry.networkMemberAuthAddress(otherMemberNetworkId);

        vm.startPrank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]); // leafCount 1
        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_TO_1);

        issuerSet.publishIssuerKey(memberNetworkId, keyX[1], keyY[1]); // leafCount 2
        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_TO_2);

        issuerSet.publishIssuerKey(memberNetworkId, keyX[2], keyY[2]); // leafCount 3
        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_2_3);

        issuerSet.publishIssuerKey(memberNetworkId, keyX[3], keyY[3]); // leafCount 4
        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_TO_4);

        issuerSet.publishIssuerKey(memberNetworkId, keyX[4], keyY[4]); // leafCount 5
        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_TO_5);

        issuerSet.publishIssuerKey(memberNetworkId, keyX[5], keyY[5]); // leafCount 6
        issuerSet.publishIssuerKey(memberNetworkId, keyX[6], keyY[6]); // leafCount 7
        issuerSet.publishIssuerKey(memberNetworkId, keyX[7], keyY[7]); // leafCount 8
        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_TO_8);
        vm.stopPrank();

        vm.prank(otherAuthAddress);
        issuerSet.publishIssuerKey(otherMemberNetworkId, keyX[8], keyY[8]); // leafCount 9
        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_TO_9);
    }

    /// @dev Slot 4 of a five-slot set is promoted twice before it meets a sibling, so its witness has
    /// only one sibling — the four-key subtree root — and packed index 1. TypeScript pins the same
    /// witness from `generateProof` on key 5 of `[L1..L5]`.
    function test_siblingsOfMatchesTypeScriptForKey5Slot4OfFiveKeys() public {
        _approveMember(memberNetworkId);
        for (uint256 i = 0; i < 5; ++i) {
            _publish(memberNetworkId, i);
        }

        (uint256[] memory siblings, uint256 pathIndex) = issuerSet.siblingsOf(4);

        assertEq(siblings.length, 1);
        assertEq(siblings[0], ROOT_OF_KEYS_1_TO_4);
        assertEq(pathIndex, 1);
    }

    /// @dev Slot 3 of the retire-then-publish history `[L1, 0, L3, L4]`: two siblings, packed index 3
    /// (binary 11), the second sibling being the two-slot root of `[L1, retired L2]` — the case most
    /// likely to drift, since it depends on a tombstone hashing correctly one level up.
    function test_siblingsOfMatchesTypeScriptForSlot3OfRetireThenPublishHistory() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);
        _publish(memberNetworkId, 2);

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, LEAF_OF_KEY_2);
        _publish(memberNetworkId, 3);

        (uint256[] memory siblings, uint256 pathIndex) = issuerSet.siblingsOf(3);

        assertEq(siblings.length, 2);
        assertEq(siblings[0], LEAF_OF_KEY_3);
        assertEq(siblings[1], ROOT_OF_KEY_1_AND_RETIRED_KEY_2);
        assertEq(pathIndex, 3);
    }

    /// @dev Slots 0 and 2 of `[L1, retired L2, L3]`: slot 0's sibling at level 0 is the tombstone
    /// itself, a live 0 rather than a promoted skip, and slot 2's sibling one level up is the two-slot
    /// root that tombstone folds into. Both must still open to `ROOT_OF_KEYS_1_2_3_LESS_2`.
    function test_siblingsOfMatchesTypeScriptForTombstoneSiblings() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);
        _publish(memberNetworkId, 2);

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, LEAF_OF_KEY_2);

        (uint256[] memory slot0Siblings, uint256 slot0PathIndex) = issuerSet.siblingsOf(0);
        assertEq(slot0Siblings.length, 2);
        assertEq(slot0Siblings[0], 0);
        assertEq(slot0Siblings[1], LEAF_OF_KEY_3);
        assertEq(slot0PathIndex, 0);

        (uint256[] memory slot2Siblings, uint256 slot2PathIndex) = issuerSet.siblingsOf(2);
        assertEq(slot2Siblings.length, 1);
        assertEq(slot2Siblings[0], ROOT_OF_KEY_1_AND_RETIRED_KEY_2);
        assertEq(slot2PathIndex, 1);

        assertEq(issuerSet.issuerSetRoot(), ROOT_OF_KEYS_1_2_3_LESS_2);
    }

    /// @dev A one-key set's sole slot has no sibling at all: an empty witness with packed index 0.
    function test_siblingsOfMatchesTypeScriptForKey1InAOneKeySet() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);

        (uint256[] memory siblings, uint256 pathIndex) = issuerSet.siblingsOf(0);

        assertEq(siblings.length, 0);
        assertEq(pathIndex, 0);
    }

    /// @dev Key 2 (slot 1) of `[L1, L2, L3]`: an ordinary two-sibling witness, packed index 1, not a
    /// promoted node — the baseline this file's promoted-slot pins are contrasted against.
    function test_siblingsOfMatchesTypeScriptForKey2InThreeKeys() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);
        _publish(memberNetworkId, 2);

        (uint256[] memory siblings, uint256 pathIndex) = issuerSet.siblingsOf(1);

        assertEq(siblings.length, 2);
        assertEq(siblings[0], LEAF_OF_KEY_1);
        assertEq(siblings[1], LEAF_OF_KEY_3);
        assertEq(pathIndex, 1);
    }
}
