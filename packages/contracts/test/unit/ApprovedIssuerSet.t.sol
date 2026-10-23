// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";
import { SNARK_SCALAR_FIELD } from "@zk-kit/lean-imt.sol/Constants.sol";

import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { IssuerSetHashes } from "../../src/libraries/IssuerSetHashes.sol";
import { ApprovedIssuerSetTestBase } from "../utils/ApprovedIssuerSetTestBase.sol";

contract ApprovedIssuerSetUnitTest is ApprovedIssuerSetTestBase {
    function test_Constructor_RevertsWhen_ZeroMemberRegistry() public {
        vm.expectRevert(ApprovedIssuerSet.ZeroMemberRegistry.selector);
        new ApprovedIssuerSet(address(0));
    }

    function test_Constructor_SetsTheDefaultRootDuration() public view {
        assertEq(issuerSet.rootDuration(), issuerSet.DEFAULT_ROOT_DURATION());
        assertEq(issuerSet.issuerSetRoot(), 0);
    }

    function test_MaxDepth_IsTwenty() public {
        assertEq(issuerSet.MAX_DEPTH(), 20);

        _approveMember(memberNetworkId);
        for (uint256 i = 0; i < 5; ++i) {
            _publish(memberNetworkId, i);
        }

        assertEq(issuerSet.MAX_DEPTH(), 20);
    }

    /// @dev depth() is ceil(log2(leafCount)), 0 for 0 or 1 slots. Checkpoints at leafCount 6 and 7
    /// are exercised (to reach the cap-8 member's ninth key via a second member) but not asserted,
    /// since they are not depth boundaries.
    function test_Depth_TracksCeilLog2OfLeafCount() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);

        assertEq(issuerSet.depth(), 0);

        _publish(memberNetworkId, 0);
        assertEq(issuerSet.depth(), 0);

        _publish(memberNetworkId, 1);
        assertEq(issuerSet.depth(), 1);

        _publish(memberNetworkId, 2);
        assertEq(issuerSet.depth(), 2);

        _publish(memberNetworkId, 3);
        assertEq(issuerSet.depth(), 2);

        _publish(memberNetworkId, 4);
        assertEq(issuerSet.depth(), 3);

        _publish(memberNetworkId, 5);
        _publish(memberNetworkId, 6);
        _publish(memberNetworkId, 7);
        assertEq(issuerSet.depth(), 3);

        _publish(otherMemberNetworkId, 8);
        assertEq(issuerSet.depth(), 4);
    }

    function test_PublishIssuerKey_StoresTheKeyCommitment() public {
        _approveMember(memberNetworkId);

        uint256 expectedLeaf = IssuerSetHashes.issuerKeyLeaf(keyX[0], keyY[0]);
        uint256 leaf = _publish(memberNetworkId, 0);

        assertEq(leaf, expectedLeaf);
        assertTrue(issuerSet.isApprovedIssuerKey(leaf));
        assertEq(issuerSet.issuerKeysOf(memberNetworkId).length, 1);
        assertEq(issuerSet.issuerKeysOf(memberNetworkId)[0], leaf);
    }

    function test_PublishIssuerKey_FirstKeyOccupiesSlotZero() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);

        assertEq(issuerSet.getLeafCount(), 1);
        assertEq(issuerSet.getSize(), 1);
        assertEq(issuerSet.getLeaf(0), leaf);
    }

    function test_PublishIssuerKey_MovesTheRoot() public {
        _approveMember(memberNetworkId);
        uint256 rootBefore = issuerSet.issuerSetRoot();

        _publish(memberNetworkId, 0);

        assertTrue(issuerSet.issuerSetRoot() != rootBefore);
    }

    /// @dev Slots are assigned in publication order, not key-value order: the tree has no ordering
    /// invariant to maintain, so an out-of-order sequence of key values still lands in ascending
    /// physical slots.
    function test_PublishIssuerKey_PublicationOrderIsSlotOrderRegardlessOfKeyValues() public {
        _approveMember(memberNetworkId);

        uint256 leaf3 = _publish(memberNetworkId, 3);
        uint256 leaf0 = _publish(memberNetworkId, 0);
        uint256 leaf4 = _publish(memberNetworkId, 4);

        assertEq(issuerSet.getLeaf(0), leaf3);
        assertEq(issuerSet.getLeaf(1), leaf0);
        assertEq(issuerSet.getLeaf(2), leaf4);
    }

    /// @dev A retirement zeroes a leaf's slot in place; it does not reclaim it. The next publish
    /// therefore appends past the tombstone rather than reusing it.
    function test_PublishIssuerKey_AppendsPastATombstone() public {
        _approveMember(memberNetworkId);
        uint256 first = _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, first);

        uint256 third = _publish(memberNetworkId, 2);

        assertEq(issuerSet.getLeaf(0), 0);
        assertEq(issuerSet.getLeaf(2), third);
        assertEq(issuerSet.getLeafCount(), 3);
    }

    function test_PublishIssuerKey_AllowsSeveralKeysPerMember() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);

        assertEq(issuerSet.issuerKeysOf(memberNetworkId).length, 2);
        assertEq(issuerSet.getSize(), 2);
    }

    function test_PublishIssuerKey_AllowsGovernanceWrite() public {
        _approveMember(memberNetworkId);

        vm.prank(owner);
        uint256 leaf = issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]);

        assertTrue(issuerSet.isApprovedIssuerKey(leaf));
    }

    function test_PublishIssuerKey_RevertsWhen_CallerNotAuthAddressOrGovernance() public {
        _approveMember(memberNetworkId);

        vm.expectRevert(ApprovedIssuerSet.UnauthorizedCaller.selector);
        vm.prank(makeAddr("attacker"));
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]);
    }

    function test_PublishIssuerKey_RevertsWhen_NotApproved() public {
        vm.expectRevert(abi.encodeWithSelector(ApprovedIssuerSet.NotApproved.selector, memberNetworkId));
        vm.prank(owner);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]);
    }

    function test_PublishIssuerKey_RevertsWhen_MemberRemoved() public {
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.prank(owner);
        registry.removeNetworkMember(memberNetworkId);

        vm.expectRevert(ApprovedIssuerSet.UnauthorizedCaller.selector);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]);
    }

    function test_PublishIssuerKey_RevertsWhen_KeyAlreadyPublished() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.expectRevert(abi.encodeWithSelector(ApprovedIssuerSet.IssuerKeyAlreadyPublished.selector, leaf));
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]);
    }

    /// @dev Two members cannot share a signing key: the tree rejects the duplicate leaf.
    function test_PublishIssuerKey_RevertsWhen_AnotherMemberPublishedTheSameKey() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);
        address otherAuthAddress = registry.networkMemberAuthAddress(otherMemberNetworkId);

        vm.expectRevert(abi.encodeWithSelector(ApprovedIssuerSet.IssuerKeyAlreadyPublished.selector, leaf));
        vm.prank(otherAuthAddress);
        issuerSet.publishIssuerKey(otherMemberNetworkId, keyX[0], keyY[0]);
    }

    function test_PublishIssuerKey_RevertsWhen_PublicKeyNotOnCurve() public {
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.expectRevert(ApprovedIssuerSet.PublicKeyNotOnCurve.selector);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[1]);
    }

    /// @dev Every low-order point satisfies the curve equation, so the curve check alone lets them
    /// through. Under one of these keys the `h·A` term of EdDSA verification takes at most eight
    /// values, so a stranger can solve for a signature over a claim tree of their choosing and mint
    /// credentials that verify as issued by an approved member.
    function test_PublishIssuerKey_RevertsWhen_PublicKeyHasLowOrder() public {
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);
        uint256[2][8] memory points = _lowOrderPoints();

        for (uint256 i = 0; i < points.length; ++i) {
            vm.expectRevert(ApprovedIssuerSet.PublicKeyHasLowOrder.selector);
            vm.prank(authAddress);
            issuerSet.publishIssuerKey(memberNetworkId, points[i][0], points[i][1]);
        }

        assertEq(issuerSet.getSize(), 0);
    }

    /// @dev Records the accepted gap: `A + (0, -1)` is on the curve with order 2l and is not one of the
    /// rejected low-order points, so it publishes as a second leaf for the same secret.
    function test_PublishIssuerKey_AcceptsMixedOrderVariant() public {
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);
        uint256 original = _publish(memberNetworkId, 0);

        vm.prank(authAddress);
        uint256 variant =
            issuerSet.publishIssuerKey(memberNetworkId, SNARK_SCALAR_FIELD - keyX[0], SNARK_SCALAR_FIELD - keyY[0]);

        assertTrue(variant != original);
        assertEq(issuerSet.getSize(), 2);
    }

    function test_PublishIssuerKey_RevertsWhen_PublicKeyNotInField() public {
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.expectRevert(ApprovedIssuerSet.PublicKeyNotInField.selector);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, type(uint256).max, keyY[0]);

        // Both coordinates, because y and y + F agree under the curve check's mulmod but commit to
        // different leaves, so one key could otherwise enter the set twice.
        vm.expectRevert(ApprovedIssuerSet.PublicKeyNotInField.selector);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], type(uint256).max);
    }

    /// @dev The cap is what keeps {retireAllIssuerKeys} inside a block.
    function test_PublishIssuerKey_RevertsWhen_KeyCapReached() public {
        _approveMember(memberNetworkId);

        for (uint256 i = 0; i < issuerSet.MAX_ISSUER_KEYS_PER_MEMBER(); ++i) {
            _publish(memberNetworkId, i);
        }

        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.expectRevert(abi.encodeWithSelector(ApprovedIssuerSet.TooManyIssuerKeys.selector, memberNetworkId));
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[9], keyY[9]);
    }

    /// @dev Forces `leafCount` to the tree's capacity via direct storage rather than publishing a
    /// million keys, so the full-tree revert path is reachable in a unit test.
    function test_PublishIssuerKey_RevertsWhen_TreeIsFull() public {
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        // `leafCount` is storage slot 1 (`forge inspect ApprovedIssuerSet storage-layout`).
        vm.store(address(issuerSet), bytes32(uint256(1)), bytes32(issuerSet.MAX_LEAVES()));

        vm.expectRevert(ApprovedIssuerSet.IssuerSetFull.selector);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]);
    }

    function test_RetireIssuerKey_RemovesTheKey() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, leaf);

        assertFalse(issuerSet.isApprovedIssuerKey(leaf));
        assertEq(issuerSet.issuerKeysOf(memberNetworkId).length, 1);
        assertEq(issuerSet.getSize(), 1);
    }

    function test_RetireIssuerKeyImmediately_StopsAcceptingTheRootTheKeyWasLiveUnder() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);
        uint256 rootWithRetiredKey = issuerSet.issuerSetRoot();

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKeyImmediately(memberNetworkId, leaf);

        assertFalse(issuerSet.isApprovedIssuerKey(leaf));
        assertFalse(issuerSet.isValidIssuerSetRoot(rootWithRetiredKey), "A stolen key must stop verifying at once");
        assertTrue(issuerSet.isValidIssuerSetRoot(issuerSet.issuerSetRoot()), "The root after retirement is valid");
    }

    function test_RetireIssuerKeyImmediately_RevertsWhen_CallerNotAuthAddressOrGovernance() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);

        vm.expectRevert(ApprovedIssuerSet.UnauthorizedCaller.selector);
        vm.prank(makeAddr("attacker"));
        issuerSet.retireIssuerKeyImmediately(memberNetworkId, leaf);
    }

    function test_RetireIssuerKey_RevertsWhen_KeyBelongsToAnotherMember() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);
        address otherAuthAddress = registry.networkMemberAuthAddress(otherMemberNetworkId);

        vm.expectRevert(
            abi.encodeWithSelector(ApprovedIssuerSet.IssuerKeyNotPublishedByMember.selector, otherMemberNetworkId, leaf)
        );
        vm.prank(otherAuthAddress);
        issuerSet.retireIssuerKey(otherMemberNetworkId, leaf);
    }

    function test_RetireIssuerKey_RevertsWhen_CallerNotAuthAddressOrGovernance() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);

        vm.expectRevert(ApprovedIssuerSet.UnauthorizedCaller.selector);
        vm.prank(makeAddr("attacker"));
        issuerSet.retireIssuerKey(memberNetworkId, leaf);
    }

    /// @dev A drained tree still has physical slots to append past, so a republish must land at a new
    /// index rather than reclaim the tombstoned one.
    function test_PublishIssuerKey_WorksAfterEveryKeyIsRetired() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);
        uint256 firstIndex = issuerSet.getLeafCount() - 1;

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, leaf);
        assertEq(issuerSet.getSize(), 0);

        uint256 republished = _publish(memberNetworkId, 1);
        uint256 secondIndex = issuerSet.getLeafCount() - 1;

        assertTrue(issuerSet.isApprovedIssuerKey(republished));
        assertEq(issuerSet.getSize(), 1);
        assertTrue(secondIndex > firstIndex);
    }

    /// @dev Retirement clears {leafSlot}, not just the tree slot, so the exact leaf that was retired
    /// is free to be published again — by the member that retired it.
    function test_PublishIssuerKey_RepublishingTheSameLeafBySameMemberUsesANewSlot() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);
        uint256 firstIndex = issuerSet.getLeafCount() - 1;

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, leaf);

        uint256 republished = _publish(memberNetworkId, 0);
        uint256 secondIndex = issuerSet.getLeafCount() - 1;

        assertEq(republished, leaf);
        assertTrue(secondIndex > firstIndex);
        assertTrue(issuerSet.isApprovedIssuerKey(republished));
        assertEq(issuerSet.getLeaf(firstIndex), 0);
        assertEq(issuerSet.getLeaf(secondIndex), republished);
    }

    /// @dev ...or by a different member entirely: {leafSlot} tracks liveness, not ownership history.
    function test_PublishIssuerKey_ADifferentMemberCanPublishAKeySomeoneElseRetired() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);

        uint256 leaf = _publish(memberNetworkId, 0);
        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, leaf);

        uint256 republished = _publish(otherMemberNetworkId, 0);

        assertEq(republished, leaf);
        assertTrue(issuerSet.isApprovedIssuerKey(republished));
        assertEq(issuerSet.issuerKeysOf(otherMemberNetworkId).length, 1);
        assertEq(issuerSet.issuerKeysOf(memberNetworkId).length, 0);
    }

    /// @dev A two-slot emptied set still hashes its tombstones together, so the root is not the
    /// empty-tree zero. The one-slot case is different: see
    /// {test_IssuerSetRoot_IsZeroAfterTheOnlySlotIsRetired}.
    function test_IssuerSetRoot_IsNonZeroAfterEveryKeyIsRetired() public {
        _approveMember(memberNetworkId);
        uint256 leaf0 = _publish(memberNetworkId, 0);
        uint256 leaf1 = _publish(memberNetworkId, 1);

        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);
        vm.prank(authAddress);
        issuerSet.retireIssuerKey(memberNetworkId, leaf0);
        vm.prank(authAddress);
        issuerSet.retireIssuerKey(memberNetworkId, leaf1);

        assertEq(issuerSet.getSize(), 0);
        assertTrue(issuerSet.issuerSetRoot() != 0);
    }

    /// @dev With one slot the root is that slot's own value, so retiring it leaves the tombstone's
    /// literal 0 as the root — there is no sibling to hash it against.
    function test_IssuerSetRoot_IsZeroAfterTheOnlySlotIsRetired() public {
        _approveMember(memberNetworkId);
        uint256 leaf = _publish(memberNetworkId, 0);

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, leaf);

        assertEq(issuerSet.getSize(), 0);
        assertEq(issuerSet.issuerSetRoot(), 0);
        assertFalse(issuerSet.isValidIssuerSetRoot(0));
    }

    /// @dev Above the touched paths, storage was never written — this contract must never precompute
    /// a zero cascade or a full tree, only the nodes on a published leaf's root path up to {depth}.
    /// Leaf 2 is the odd one out of a 3-leaf tree, so it promotes to level 1 unchanged instead of
    /// hashing against a zero pad.
    function test_NodesAboveTheLivePrefixAreZero() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        _publish(memberNetworkId, 1);
        _publish(memberNetworkId, 2);

        // Leaf level: index 3 was never published.
        assertEq(issuerSet.getNode(0, 3), 0);

        // Level 1: leaves {0,1} pair up; leaf 2 is unpaired and promotes unchanged.
        assertTrue(issuerSet.getNode(1, 0) != 0);
        assertEq(issuerSet.getNode(1, 1), issuerSet.getNode(0, 2));
        assertEq(issuerSet.getNode(1, 2), 0);

        // Level 2 is the root; nothing past depth() is ever written.
        assertTrue(issuerSet.getNode(2, 0) != 0);
        assertEq(issuerSet.getNode(2, 1), 0);
        assertEq(issuerSet.getNode(3, 0), 0);

        assertEq(issuerSet.depth(), 2);
    }

    /// @dev A promoted node is stale the instant it gets a sibling: growing a set from 4 to 5 slots
    /// promotes leaf 4 (key 5) unchanged to two ancestor levels, and growing to 6 slots must overwrite
    /// both of those promoted copies with the real pairwise hash, not leave the promotion in place.
    function test_RecomputeNode_OverwritesAPromotedNodeOnceItGetsASibling() public {
        _approveMember(memberNetworkId);
        for (uint256 i = 0; i < 4; ++i) {
            _publish(memberNetworkId, i);
        }

        uint256 leafOfKey5 = _publish(memberNetworkId, 4);
        assertEq(issuerSet.getNode(1, 2), leafOfKey5);
        assertEq(issuerSet.getNode(2, 1), leafOfKey5);

        uint256 leafOfKey6 = _publish(memberNetworkId, 5);
        uint256 paired = IssuerSetHashes.internalNode(leafOfKey5, leafOfKey6);
        assertEq(issuerSet.getNode(1, 2), paired);
        assertEq(issuerSet.getNode(2, 1), paired);
    }

    /// @dev Retiring a promoted leaf must zero every promoted copy of it above the leaf level, all the
    /// way up to where an ancestor stops being a bare promotion and starts being a real hash.
    function test_RetireIssuerKey_ZeroesEveryPromotedCopyAboveARetiredSlot() public {
        _approveMember(memberNetworkId);
        for (uint256 i = 0; i < 5; ++i) {
            _publish(memberNetworkId, i);
        }
        uint256 leafOfKey5 = issuerSet.getLeaf(4);
        assertEq(issuerSet.getNode(1, 2), leafOfKey5);
        assertEq(issuerSet.getNode(2, 1), leafOfKey5);

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, leafOfKey5);

        assertEq(issuerSet.getNode(1, 2), 0);
        assertEq(issuerSet.getNode(2, 1), 0);
    }

    function test_RetireAllIssuerKeys_RevertsWhen_CallerIsNotTheMemberRegistry() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);

        vm.expectRevert(ApprovedIssuerSet.CallerIsNotTheMemberRegistry.selector);
        vm.prank(owner);
        issuerSet.retireAllIssuerKeys(memberNetworkId);
    }

    function test_RetireAllIssuerKeys_DoesNothingForAMemberWithNoKeys() public {
        _approveMember(memberNetworkId);
        uint256 rootBefore = issuerSet.issuerSetRoot();

        vm.recordLogs();
        _retireAll(memberNetworkId);

        assertEq(issuerSet.issuerSetRoot(), rootBefore);
        assertEq(vm.getRecordedLogs().length, 0);
        // A member that never published gates {hasEverPublished}, so this is a no-op at the watermark
        // too, not just at the tree.
        assertEq(issuerSet.rootsInvalidatedAt(), 0);
    }

    /// @dev Batching means no intermediate root exists for a key retired mid-batch to carry — every
    /// event in the batch must carry the one root the batch actually settled on.
    function test_RetireAllIssuerKeys_EmitsOneEventPerKeyWithTheFinalRoot() public {
        _approveMember(memberNetworkId);
        uint256 leaf0 = _publish(memberNetworkId, 0);
        uint256 leaf1 = _publish(memberNetworkId, 1);
        uint256 leaf2 = _publish(memberNetworkId, 2);

        vm.recordLogs();
        _retireAll(memberNetworkId);

        uint256 finalRoot = issuerSet.issuerSetRoot();
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256[] memory seenLeaves = new uint256[](3);
        uint256 matchCount;

        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] != ApprovedIssuerSet.IssuerKeyRetired.selector) continue;

            assertEq(logs[i].topics[1], memberNetworkId);
            (uint256 leaf, uint256 root) = abi.decode(logs[i].data, (uint256, uint256));
            assertEq(root, finalRoot);

            seenLeaves[matchCount] = leaf;
            ++matchCount;
        }

        assertEq(matchCount, 3);
        assertEq(seenLeaves[0], leaf0);
        assertEq(seenLeaves[1], leaf1);
        assertEq(seenLeaves[2], leaf2);
    }

    /// @dev A promoted node is never reused as a sibling for a different width, so root revival is
    /// gone: retiring B's key does not hand the root back to A's earlier one-slot root. The removal
    /// path still has to close A's earlier root off on A's own removal.
    function test_RetireAllIssuerKeys_InvalidatesAnEarlierRootAfterARetirement() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);

        _publish(memberNetworkId, 0);
        uint256 earlierRoot = issuerSet.issuerSetRoot();

        uint256 y = _publish(otherMemberNetworkId, 1);

        vm.prank(registry.networkMemberAuthAddress(otherMemberNetworkId));
        issuerSet.retireIssuerKey(otherMemberNetworkId, y);
        assertTrue(issuerSet.issuerSetRoot() != earlierRoot);
        assertTrue(issuerSet.isValidIssuerSetRoot(earlierRoot));

        _retireAll(memberNetworkId);

        assertFalse(issuerSet.isValidIssuerSetRoot(earlierRoot));
    }

    /// @dev The root-read-order regression for {publishIssuerKeys} onto a non-empty set: batching two
    /// more keys onto a one-slot set grows the depth from 0 to 2, so `oldRoot` must still be read at
    /// the pre-batch depth, not the post-batch one, or the one-slot root is never superseded at all.
    function test_PublishIssuerKeys_OntoANonEmptySetSupersedesThePreBatchRoot() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        uint256 preBatchRoot = issuerSet.issuerSetRoot();
        assertEq(issuerSet.depth(), 0);

        uint256[2][] memory keys = new uint256[2][](2);
        keys[0] = [keyX[1], keyY[1]];
        keys[1] = [keyX[2], keyY[2]];

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.publishIssuerKeys(memberNetworkId, keys);

        assertEq(issuerSet.depth(), 2);
        assertTrue(issuerSet.isValidIssuerSetRoot(preBatchRoot));

        vm.warp(block.timestamp + issuerSet.rootDuration());

        assertFalse(issuerSet.isValidIssuerSetRoot(preBatchRoot));
    }

    /// @dev The root-read-order regression for {publishIssuerKeys}: on an empty set, the depth-0 root
    /// slot is the first leaf about to be written. Reading `oldRoot` after the loop instead of before
    /// it would stamp that leaf value as a bogus superseded root.
    function test_PublishIssuerKeys_EmptySetDoesNotStampTheFirstLeafAsASupersededRoot() public {
        _approveMember(memberNetworkId);

        uint256[2][] memory keys = new uint256[2][](2);
        keys[0] = [keyX[0], keyY[0]];
        keys[1] = [keyX[1], keyY[1]];

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        uint256[] memory leaves = issuerSet.publishIssuerKeys(memberNetworkId, keys);

        assertEq(issuerSet.rootSupersededAt(leaves[0]), 0);
        assertFalse(issuerSet.isValidIssuerSetRoot(leaves[0]));
    }

    /// @dev The root-read-order regression for {publishIssuerKey} across a depth change: growing from
    /// one slot to two moves the root from depth 0 to depth 1, so the one-slot root must still be
    /// captured and stamped as superseded, not silently dropped.
    function test_PublishIssuerKey_GrowingFromOneSlotToTwoSupersedesTheOneSlotRoot() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        uint256 oneSlotRoot = issuerSet.issuerSetRoot();

        _publish(memberNetworkId, 1);

        assertTrue(issuerSet.isValidIssuerSetRoot(oneSlotRoot));

        vm.warp(block.timestamp + issuerSet.rootDuration());

        assertFalse(issuerSet.isValidIssuerSetRoot(oneSlotRoot));
    }

    /// @dev On a one-slot set the root lives at the leaf itself, so retirement must produce a root of
    /// exactly 0 and leave the old root unable to validate.
    function test_RetireAllIssuerKeys_OneSlotSetRootBecomesZeroAndOldRootIsImmediatelyInvalid() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        uint256 oldRoot = issuerSet.issuerSetRoot();

        _retireAll(memberNetworkId);

        assertEq(issuerSet.issuerSetRoot(), 0);
        assertFalse(issuerSet.isValidIssuerSetRoot(oldRoot));
    }

    /// @dev The watermark regression this whole mechanism exists for. {retireAllIssuerKeys} only ever
    /// deleted the stamp on the one root it directly replaced (C below); B — superseded earlier in the
    /// same removal's window, and still embedding the member's then-live second key — kept validating
    /// for up to a full `rootDuration` after removal. A removed member could rebuild a witness against
    /// B (the leaf table is public via {getLeaves}) and keep signing credentials that verify as an
    /// approved member's. Fails without {ApprovedIssuerSet-rootsInvalidatedAt}.
    function test_RetireAllIssuerKeys_InvalidatesEveryPreRemovalRootTheMemberWasLiveUnder() public {
        _approveMember(memberNetworkId);

        uint256 firstKey = _publish(memberNetworkId, 0); // root A
        _publish(memberNetworkId, 1); // A superseded, root B
        uint256 rootB = issuerSet.issuerSetRoot();

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, firstKey); // B superseded, root C
        assertTrue(issuerSet.isValidIssuerSetRoot(rootB), "B is still inside its own grace window here");

        _retireAll(memberNetworkId); // the registry-driven removal retires the member's last key

        assertFalse(issuerSet.isValidIssuerSetRoot(rootB));
    }

    /// @dev The cross-member variant: the root superseded inside a removed member's watermark
    /// window need not be superseded by that member's own traffic. Another member's publish
    /// supersedes it just as well, and {rootsInvalidatedAt} has to close it off regardless of whose
    /// write moved the root.
    function test_RetireAllIssuerKeys_InvalidatesAKeyBearingRootSupersededByAnotherMember() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);

        vm.warp(1000);
        _publish(memberNetworkId, 0);
        uint256 keyBearingRoot = issuerSet.issuerSetRoot();

        vm.warp(1100);
        _publish(otherMemberNetworkId, 1); // keyBearingRoot superseded by otherMemberNetworkId's write
        assertTrue(issuerSet.isValidIssuerSetRoot(keyBearingRoot), "still inside its own grace window here");

        vm.warp(1200);
        _retireAll(memberNetworkId);

        assertEq(issuerSet.rootsInvalidatedAt(), 1200);
        assertFalse(issuerSet.isValidIssuerSetRoot(keyBearingRoot));
    }

    /// @dev The self-retire-first variant: a member that retires its own keys before exiting stamps a
    /// key-bearing root on every retirement, then hits {retireAllIssuerKeys}'s `count == 0` path.
    /// Gating the watermark on {hasEverPublished} rather than on `count` is what still closes that root.
    function test_RetireAllIssuerKeys_SelfRetireFirstStillInvalidatesTheRootTheKeyWasLiveUnder() public {
        _approveMember(memberNetworkId);

        uint256 leaf = _publish(memberNetworkId, 0);
        uint256 rootWithLiveKey = issuerSet.issuerSetRoot();

        vm.prank(registry.networkMemberAuthAddress(memberNetworkId));
        issuerSet.retireIssuerKey(memberNetworkId, leaf);
        assertTrue(issuerSet.isValidIssuerSetRoot(rootWithLiveKey));
        assertEq(issuerSet.issuerKeysOf(memberNetworkId).length, 0);

        _retireAll(memberNetworkId); // count == 0: nothing left to retire, but history still closes

        assertEq(issuerSet.rootsInvalidatedAt(), block.timestamp);
        assertFalse(issuerSet.isValidIssuerSetRoot(rootWithLiveKey));
    }

    /// @dev The watermark must not shadow the fast path: whatever root is current the instant after a
    /// removal has to keep validating, even though the same call just bumped {rootsInvalidatedAt} to
    /// this very timestamp.
    function test_RetireAllIssuerKeys_TheRootTheRemovalItselfProducesStaysValid() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);

        _publish(memberNetworkId, 0);
        _publish(otherMemberNetworkId, 1);

        _retireAll(otherMemberNetworkId);

        assertTrue(issuerSet.isValidIssuerSetRoot(issuerSet.issuerSetRoot()));
    }

    /// @dev Bounded blast radius: removing a member that never published must not touch the watermark,
    /// so every other member's still-in-window superseded root survives that removal untouched.
    function test_RetireAllIssuerKeys_KeylessMemberDoesNotBumpTheWatermarkOrInvalidateOthers() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);

        _publish(otherMemberNetworkId, 0);
        uint256 othersSupersededRoot = issuerSet.issuerSetRoot();
        _publish(otherMemberNetworkId, 1); // othersSupersededRoot superseded, still inside its window

        _retireAll(memberNetworkId); // memberNetworkId never published a key

        assertEq(issuerSet.rootsInvalidatedAt(), 0);
        assertTrue(issuerSet.isValidIssuerSetRoot(othersSupersededRoot));
    }

    /// @dev Publishing through 1, 2, and 4 slots (depths 0, 1, 2) supersedes two different roots at two
    /// different depths. Each stays valid inside its own `rootDuration` window right up to the removal;
    /// a real member removal through the registry — not the {_retireAll} shortcut every other watermark
    /// test here uses — then closes both at once via {rootsInvalidatedAt}, each still inside its own
    /// window when removal lands.
    ///
    /// {test_PublishIssuerKey_GrowingFromOneSlotToTwoSupersedesTheOneSlotRoot} already covers a single
    /// 1-to-2 growth step's window behaviour without a removal, and
    /// {test_RetireAllIssuerKeys_InvalidatesEveryPreRemovalRootTheMemberWasLiveUnder} already covers the
    /// watermark invalidating an earlier root — but only via {_retireAll}, and without the depth ever
    /// growing past 2 slots. This test is the case neither covers: growth to 4 slots, and invalidation
    /// through the actual `registry.removeNetworkMember` path.
    function test_RemoveNetworkMember_InvalidatesEverySupersededRootAcrossADepthGrowingHistory() public {
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.warp(1000);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]); // leafCount 1, depth 0
        uint256 rootAtOneSlot = issuerSet.issuerSetRoot();

        vm.warp(1100);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[1], keyY[1]); // supersedes rootAtOneSlot; depth 1
        uint256 rootAtTwoSlots = issuerSet.issuerSetRoot();

        vm.warp(1200);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[2], keyY[2]); // leafCount 3
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[3], keyY[3]); // supersedes rootAtTwoSlots; depth 2

        assertTrue(issuerSet.isValidIssuerSetRoot(rootAtOneSlot));
        assertTrue(issuerSet.isValidIssuerSetRoot(rootAtTwoSlots));

        vm.prank(owner);
        registry.removeNetworkMember(memberNetworkId);

        assertFalse(issuerSet.isValidIssuerSetRoot(rootAtOneSlot));
        assertFalse(issuerSet.isValidIssuerSetRoot(rootAtTwoSlots));
    }

    /// @dev Companion to
    /// {test_RemoveNetworkMember_InvalidatesEverySupersededRootAcrossADepthGrowingHistory}: the same
    /// 1-to-2-to-4-slot growth, but with no removal, isolating that each root's window runs from when
    /// it was superseded rather than from some other instant. rootAtOneSlot is superseded at 1100 and
    /// rootAtTwoSlots at 1200; warping to just past rootAtOneSlot's window must invalidate only that
    /// root, not rootAtTwoSlots.
    function test_IsValidIssuerSetRoot_WindowRunsFromSupersessionAcrossDepthGrowth() public {
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.warp(1000);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]); // leafCount 1, depth 0
        uint256 rootAtOneSlot = issuerSet.issuerSetRoot();

        vm.warp(1100);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[1], keyY[1]); // supersedes rootAtOneSlot; depth 1
        uint256 rootAtTwoSlots = issuerSet.issuerSetRoot();

        vm.warp(1200);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[2], keyY[2]); // leafCount 3
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[3], keyY[3]); // supersedes rootAtTwoSlots; depth 2

        // rootAtOneSlot's window (superseded at 1100) has just elapsed; rootAtTwoSlots's (superseded at
        // 1200) has not.
        vm.warp(1100 + issuerSet.rootDuration());
        assertFalse(issuerSet.isValidIssuerSetRoot(rootAtOneSlot));
        assertTrue(issuerSet.isValidIssuerSetRoot(rootAtTwoSlots));
    }

    function test_IsValidIssuerSetRoot_ReturnsFalseForZeroAndUnknownRoots() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);

        assertFalse(issuerSet.isValidIssuerSetRoot(0));
        assertFalse(issuerSet.isValidIssuerSetRoot(uint256(keccak256("never a root"))));
    }

    function test_IsValidIssuerSetRoot_AcceptsTheCurrentRootIndefinitely() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        uint256 root = issuerSet.issuerSetRoot();

        vm.warp(block.timestamp + 3650 days);

        assertTrue(issuerSet.isValidIssuerSetRoot(root));
    }

    function test_IsValidIssuerSetRoot_AcceptsASupersededRootInsideTheWindow() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        uint256 superseded = issuerSet.issuerSetRoot();
        _publish(memberNetworkId, 1);

        vm.warp(block.timestamp + issuerSet.rootDuration() - 1);

        assertTrue(issuerSet.isValidIssuerSetRoot(superseded));
    }

    function test_IsValidIssuerSetRoot_RejectsASupersededRootAtTheWindowEnd() public {
        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        uint256 superseded = issuerSet.issuerSetRoot();
        _publish(memberNetworkId, 1);

        vm.warp(block.timestamp + issuerSet.rootDuration());

        assertFalse(issuerSet.isValidIssuerSetRoot(superseded));
    }

    function test_IsValidIssuerSetRoot_AcceptsASupersededRootWithTheMaximumWindow() public {
        // The largest window means governance never wants superseded roots to expire, so the check
        // has to keep accepting them at that value rather than overflow.
        vm.prank(owner);
        issuerSet.updateRootDuration(type(uint256).max);

        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        uint256 superseded = issuerSet.issuerSetRoot();
        _publish(memberNetworkId, 1);

        vm.warp(block.timestamp + 365 days);

        assertTrue(issuerSet.isValidIssuerSetRoot(superseded));
    }

    function test_UpdateRootDuration_ReplacesTheWindow() public {
        vm.expectEmit();
        emit ApprovedIssuerSet.RootDurationUpdated(issuerSet.DEFAULT_ROOT_DURATION(), 0);
        vm.prank(owner);
        issuerSet.updateRootDuration(0);

        assertEq(issuerSet.rootDuration(), 0);
    }

    function test_UpdateRootDuration_RevertsWhen_CallerNotGovernance() public {
        vm.expectRevert(ApprovedIssuerSet.UnauthorizedCaller.selector);
        vm.prank(makeAddr("attacker"));
        issuerSet.updateRootDuration(0);
    }

    /// @dev Folds every slot's siblings, packed by pathIndex, back to the root — the same check the
    /// circuit's binary_merkle_root performs. Slot 4 of a 5-slot tree has one sibling and pathIndex 1,
    /// since it is the odd node promoted straight from level 0 to level 1.
    function test_SiblingsOf_FoldsToTheRootForEverySlotOfAFiveSlotSet() public {
        _approveMember(memberNetworkId);
        for (uint256 i = 0; i < 5; ++i) {
            _publish(memberNetworkId, i);
        }

        uint256[5] memory expectedLengths = [uint256(3), 3, 3, 3, 1];

        for (uint256 index = 0; index < 5; ++index) {
            (uint256[] memory siblings, uint256 pathIndex) = issuerSet.siblingsOf(index);

            assertEq(siblings.length, expectedLengths[index]);

            uint256 node = issuerSet.getLeaf(index);
            for (uint256 level; level < siblings.length; ++level) {
                bool isRightChild = (pathIndex >> level) & 1 == 1;
                node = isRightChild
                    ? IssuerSetHashes.internalNode(siblings[level], node)
                    : IssuerSetHashes.internalNode(node, siblings[level]);
            }

            assertEq(node, issuerSet.issuerSetRoot());
        }

        (, uint256 slot4PathIndex) = issuerSet.siblingsOf(4);
        assertEq(slot4PathIndex, 1);

        uint256 leafCount = issuerSet.getLeafCount();
        vm.expectRevert(abi.encodeWithSelector(ApprovedIssuerSet.LeafIndexOutOfRange.selector, leafCount));
        issuerSet.siblingsOf(leafCount);
    }

    /// @dev {depth} and {siblingsOf} at the MAX_DEPTH boundary, forced via `leafCount`'s storage slot
    /// rather than a 2^19-key publish history. `MAX_LEAVES - 1`'s bits are all set, so every level
    /// down to the last has a sibling and the packed index equals the physical index unchanged.
    function test_Depth_AndSiblingsOf_RespectTheMaxDepthBoundary() public {
        vm.store(address(issuerSet), bytes32(uint256(1)), bytes32(uint256(2 ** 19)));
        assertEq(issuerSet.depth(), 19);

        vm.store(address(issuerSet), bytes32(uint256(1)), bytes32(uint256(2 ** 19 + 1)));
        assertEq(issuerSet.depth(), 20);

        vm.store(address(issuerSet), bytes32(uint256(1)), bytes32(issuerSet.MAX_LEAVES()));
        assertEq(issuerSet.depth(), 20);

        (uint256[] memory siblings, uint256 pathIndex) = issuerSet.siblingsOf(issuerSet.MAX_LEAVES() - 1);
        assertEq(siblings.length, 20);
        assertEq(pathIndex, issuerSet.MAX_LEAVES() - 1);
    }

    /// @dev Generous ceiling so only a real regression fails this: steady-state publish costs one
    /// {depth}-hash path plus bookkeeping, `depth` tracking `ceil(log2(leafCount))` rather than a
    /// fixed 20. The very first write into a brand-new tree is excluded on purpose — every node on its
    /// path is a cold zero-to-nonzero SSTORE, which is not the steady-state cost this ceiling targets.
    function test_PublishIssuerKey_GasCeiling() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);
        _publish(otherMemberNetworkId, 9);

        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.prank(authAddress);
        uint256 gasBefore = gasleft();
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]);
        uint256 gasUsed = gasBefore - gasleft();

        // 1.1x the measured 954,065 under Glamsterdam: depth now tracks leafCount, so this is a fraction of the old
        // fixed-20-level ceiling.
        assertLt(gasUsed, 1_049_472);
    }

    /// @dev Generous ceiling so only a real regression fails this: batching 8 contiguous retirements
    /// shares one recompute pass, {depth} levels deep, instead of paying it 8 times over.
    function test_RetireAllIssuerKeys_GasCeiling_EightContiguousKeys() public {
        _approveMember(memberNetworkId);
        for (uint256 i = 0; i < issuerSet.MAX_ISSUER_KEYS_PER_MEMBER(); ++i) {
            _publish(memberNetworkId, i);
        }

        vm.prank(address(registry));
        uint256 gasBefore = gasleft();
        issuerSet.retireAllIssuerKeys(memberNetworkId);
        uint256 gasUsed = gasBefore - gasleft();

        // 1.1x the measured 790,425 under Glamsterdam.
        assertLt(gasUsed, 869_468);
    }

    /// @dev Isolates the depth effect on real publishes rather than a storage-forced tree: `shallow`
    /// publishes its 4th key (depth stays 2), `deep` its 10th across two members (depth stays 4, the
    /// most the fixture's 10 keys reach). Neither adds a level, since under Glamsterdam the new
    /// storage a level needs costs more than the hashing this test compares. The 4-level recompute
    /// must cost only a handful of Poseidon hashes more than the 2-level one, not the 18 extra levels
    /// a fixed-20 tree would have charged regardless of real size. Two bounds check that: an
    /// absolute one on `gasDeep` a fixed-depth contract cannot pass, and a `gasDeep - gasShallow` one
    /// that catches a per-level regression an absolute bound alone would miss.
    function test_PublishIssuerKey_CostTracksDepth() public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);
        address otherAuthAddress = registry.networkMemberAuthAddress(otherMemberNetworkId);

        ApprovedIssuerSet shallow = new ApprovedIssuerSet(address(registry));
        ApprovedIssuerSet deep = new ApprovedIssuerSet(address(registry));

        for (uint256 i; i < 3; ++i) {
            vm.prank(authAddress);
            shallow.publishIssuerKey(memberNetworkId, keyX[i], keyY[i]);
        }

        for (uint256 i; i < issuerSet.MAX_ISSUER_KEYS_PER_MEMBER(); ++i) {
            vm.prank(authAddress);
            deep.publishIssuerKey(memberNetworkId, keyX[i], keyY[i]);
        }
        vm.prank(otherAuthAddress);
        deep.publishIssuerKey(otherMemberNetworkId, keyX[8], keyY[8]);

        assertEq(shallow.depth(), 2);
        assertEq(deep.depth(), 4);

        vm.prank(authAddress);
        uint256 gasBeforeShallow = gasleft();
        shallow.publishIssuerKey(memberNetworkId, keyX[3], keyY[3]);
        uint256 gasShallow = gasBeforeShallow - gasleft();
        assertEq(shallow.depth(), 2);

        vm.prank(otherAuthAddress);
        uint256 gasBeforeDeep = gasleft();
        deep.publishIssuerKey(otherMemberNetworkId, keyX[9], keyY[9]);
        uint256 gasDeep = gasBeforeDeep - gasleft();
        assertEq(deep.depth(), 4);

        // 1.1x the measured 721,070 under Glamsterdam, below the roughly 937,000 a fixed 20-level
        // recompute would cost here (16 more levels at the per-level rate below): a regression back to
        // a 20-level recompute regardless of the tree's real size would still pass a check against
        // `gasShallow`, since both publishes would pay the same fixed cost, but not this absolute one.
        assertLt(gasDeep, 793_177);

        // 1.1x the measured 26,971 under Glamsterdam: two extra recompute levels, not the ~243,000
        // the 18 extra levels of a fixed-20 tree would cost at this same per-level rate.
        assertLt(gasDeep - gasShallow, 29_668);
    }
}
