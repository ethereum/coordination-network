// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { SNARK_SCALAR_FIELD } from "@zk-kit/lean-imt.sol/Constants.sol";

import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { IssuerSetHashes } from "../../src/libraries/IssuerSetHashes.sol";
import { ApprovedIssuerSetTestBase } from "../utils/ApprovedIssuerSetTestBase.sol";

contract ApprovedIssuerSetFuzzTest is ApprovedIssuerSetTestBase {
    /// @dev `publishIssuerKeys` must land on the same tree a caller would get by calling
    /// `publishIssuerKey` once per key, from the same starting size. `otherMemberNetworkId` seeds 0-4
    /// pre-existing slots one at a time on both sets (identically, so the two start equal), which lets
    /// the fuzzer roll a starting size that crosses a power-of-two boundary (e.g. growing 4 -> 5) right
    /// where `memberNetworkId`'s batch begins.
    function testFuzz_PublishIssuerKeys_MatchesSequentialPublish(uint8 rawStartCount, uint8 rawBatchCount) public {
        uint256 startCount = bound(rawStartCount, 0, 4);
        uint256 batchCount = bound(rawBatchCount, 1, 6);
        vm.assume(startCount + batchCount <= 10);

        ApprovedIssuerSet sequential = new ApprovedIssuerSet(address(registry));

        _approveMember(memberNetworkId);
        if (startCount > 0) _approveMember(otherMemberNetworkId);

        if (startCount > 0) {
            address otherAuth = registry.networkMemberAuthAddress(otherMemberNetworkId);
            for (uint256 i; i < startCount; ++i) {
                vm.prank(otherAuth);
                issuerSet.publishIssuerKey(otherMemberNetworkId, keyX[i], keyY[i]);
                vm.prank(otherAuth);
                sequential.publishIssuerKey(otherMemberNetworkId, keyX[i], keyY[i]);
            }
        }

        // Both trees are still identical here, so either can stand in for "the root before this
        // member's keys land" — 0 when startCount is 0, since neither tree has been written yet.
        uint256 preBatchRoot = issuerSet.issuerSetRoot();

        uint256[2][] memory keys = new uint256[2][](batchCount);
        for (uint256 i; i < batchCount; ++i) {
            keys[i] = [keyX[startCount + i], keyY[startCount + i]];
        }

        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);
        vm.prank(authAddress);
        issuerSet.publishIssuerKeys(memberNetworkId, keys);

        for (uint256 i; i < batchCount; ++i) {
            vm.prank(authAddress);
            sequential.publishIssuerKey(memberNetworkId, keys[i][0], keys[i][1]);
        }

        assertEq(issuerSet.issuerSetRoot(), sequential.issuerSetRoot());
        assertEq(issuerSet.depth(), sequential.depth());
        assertEq(issuerSet.getLeafCount(), sequential.getLeafCount());
        _assertSameNodesOnEveryLevel(issuerSet, sequential);

        // isValidIssuerSetRoot(0) is false by definition, so only check when there was a real
        // pre-batch root to supersede.
        if (preBatchRoot != 0) {
            assertTrue(issuerSet.isValidIssuerSetRoot(preBatchRoot));
            assertTrue(sequential.isValidIssuerSetRoot(preBatchRoot));
        }
    }

    /// @dev `retireAllIssuerKeys` for a member must land on the same tree as retiring that member's
    /// keys one by one with `retireIssuerKey`. `otherMemberNetworkId` again seeds a variable starting
    /// size, so `memberNetworkId`'s keys can land across a promoted slot (e.g. slot 4 of 5, or slots 7
    /// and 8 of 9 when the starting size and key count are large enough).
    function testFuzz_RetireAllIssuerKeys_MatchesSequentialRetire(uint8 rawStartCount, uint8 rawMemberCount) public {
        uint256 startCount = bound(rawStartCount, 0, 4);
        uint256 memberCount = bound(rawMemberCount, 1, 6);
        vm.assume(startCount + memberCount <= 10);

        ApprovedIssuerSet sequential = new ApprovedIssuerSet(address(registry));

        _approveMember(memberNetworkId);
        if (startCount > 0) _approveMember(otherMemberNetworkId);

        if (startCount > 0) {
            address otherAuth = registry.networkMemberAuthAddress(otherMemberNetworkId);
            for (uint256 i; i < startCount; ++i) {
                vm.prank(otherAuth);
                issuerSet.publishIssuerKey(otherMemberNetworkId, keyX[i], keyY[i]);
                vm.prank(otherAuth);
                sequential.publishIssuerKey(otherMemberNetworkId, keyX[i], keyY[i]);
            }
        }

        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);
        uint256[] memory memberLeaves = new uint256[](memberCount);
        for (uint256 i; i < memberCount; ++i) {
            vm.prank(authAddress);
            memberLeaves[i] = issuerSet.publishIssuerKey(memberNetworkId, keyX[startCount + i], keyY[startCount + i]);
            vm.prank(authAddress);
            sequential.publishIssuerKey(memberNetworkId, keyX[startCount + i], keyY[startCount + i]);
        }

        vm.prank(address(registry));
        issuerSet.retireAllIssuerKeys(memberNetworkId);

        for (uint256 i; i < memberCount; ++i) {
            vm.prank(authAddress);
            sequential.retireIssuerKey(memberNetworkId, memberLeaves[i]);
        }

        assertEq(issuerSet.issuerSetRoot(), sequential.issuerSetRoot());
        assertEq(issuerSet.depth(), sequential.depth());
        assertEq(issuerSet.getLeafCount(), sequential.getLeafCount());
        _assertSameNodesOnEveryLevel(issuerSet, sequential);
    }

    /// @dev Every node on every live level must match, not just the root: two trees can share a root
    /// by coincidence far more easily than they can share every intermediate node.
    function _assertSameNodesOnEveryLevel(ApprovedIssuerSet a, ApprovedIssuerSet b) private view {
        uint256 depth = a.depth();
        uint256 width = a.getLeafCount();

        for (uint256 level; level <= depth; ++level) {
            for (uint256 index; index < width; ++index) {
                assertEq(a.getNode(level, index), b.getNode(level, index));
            }
            width = (width + 1) >> 1;
        }
    }

    /// @dev Slots are never reused, so every leaf a member published keeps the physical index it was
    /// assigned however the keys were ordered on the way in.
    function testFuzz_PublishedKeysKeepTheirSlots(uint8 rawKeyCount, uint8 rawOffset) public {
        uint256 keyCount = bound(rawKeyCount, 1, issuerSet.MAX_ISSUER_KEYS_PER_MEMBER());
        uint256 offset = bound(rawOffset, 0, 9);

        _approveMember(memberNetworkId);

        uint256[] memory leaves = new uint256[](keyCount);
        for (uint256 i = 0; i < keyCount; ++i) {
            leaves[i] = _publish(memberNetworkId, (i + offset) % 10);
        }

        for (uint256 i = 0; i < keyCount; ++i) {
            assertEq(issuerSet.getLeaf(i), leaves[i]);
        }
    }

    /// @dev Acceptance of a superseded root is exactly "elapsed is inside the window".
    function testFuzz_IsValidIssuerSetRoot_TracksTheWindow(uint256 rawElapsed) public {
        uint256 rootDuration = issuerSet.rootDuration();
        uint256 elapsed = bound(rawElapsed, 0, rootDuration * 2);

        _approveMember(memberNetworkId);
        _publish(memberNetworkId, 0);
        uint256 superseded = issuerSet.issuerSetRoot();
        _publish(memberNetworkId, 1);

        vm.warp(block.timestamp + elapsed);

        assertEq(issuerSet.isValidIssuerSetRoot(superseded), elapsed < rootDuration);
    }

    function testFuzz_PublishIssuerKey_RevertsWhen_CallerNotAuthAddressOrGovernance(address caller) public {
        _approveMember(memberNetworkId);

        vm.assume(caller != registry.networkMemberAuthAddress(memberNetworkId));
        vm.assume(caller != owner);

        vm.expectRevert(ApprovedIssuerSet.UnauthorizedCaller.selector);
        vm.prank(caller);
        issuerSet.publishIssuerKey(memberNetworkId, keyX[0], keyY[0]);
    }

    function testFuzz_publishIssuerKey_RevertWhen_PublicKeyIsOffCurve(uint256 publicKeyY) public {
        uint256 reflectedKeyY = SNARK_SCALAR_FIELD - KEY_1_Y;
        publicKeyY = bound(publicKeyY, 0, SNARK_SCALAR_FIELD - 1);
        vm.assume(publicKeyY != KEY_1_Y && publicKeyY != reflectedKeyY);
        _approveMember(memberNetworkId);
        address authAddress = registry.networkMemberAuthAddress(memberNetworkId);

        vm.expectRevert(ApprovedIssuerSet.PublicKeyNotOnCurve.selector);
        vm.prank(authAddress);
        issuerSet.publishIssuerKey(memberNetworkId, KEY_1_X, publicKeyY);
    }

    /// @dev The reference implements spec 03's compacted-level loop literally, independent of
    /// {ApprovedIssuerSet}'s incremental `nodes[level]` cache: catches any drift between the two, such
    /// as a padding mistake or a stale node the recompute pass failed to touch. `getLeaves` is the
    /// same private-rebuild path a holder uses, so this doubles as a check that it returns what the
    /// tree actually committed to.
    function testFuzz_RootMatchesTheReferenceConstruction(uint256 seed) public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);

        // 0 = unowned, 1 = held live by `memberNetworkId`, 2 = held live by `otherMemberNetworkId`.
        uint8[10] memory keyOwner;
        uint256[10] memory publishedLeaf;
        bool everPublished;

        for (uint256 step; step < 24; ++step) {
            uint256 rand = uint256(keccak256(abi.encodePacked(seed, step)));

            if (rand % 2 == 0) {
                uint256 pick = _findByOwner(keyOwner, rand, 0);
                if (pick == type(uint256).max) continue;

                bool useFirstMember = (rand >> 8) % 2 == 0;
                bytes32 id = useFirstMember ? memberNetworkId : otherMemberNetworkId;

                if (issuerSet.issuerKeysOf(id).length >= issuerSet.MAX_ISSUER_KEYS_PER_MEMBER()) {
                    useFirstMember = !useFirstMember;
                    id = useFirstMember ? memberNetworkId : otherMemberNetworkId;
                    if (issuerSet.issuerKeysOf(id).length >= issuerSet.MAX_ISSUER_KEYS_PER_MEMBER()) continue;
                }

                publishedLeaf[pick] = _publish(id, pick);
                keyOwner[pick] = useFirstMember ? 1 : 2;
                everPublished = true;
            } else {
                uint256 pick = _findByOwner(keyOwner, rand, 1);
                if (pick == type(uint256).max) continue;

                bytes32 id = keyOwner[pick] == 1 ? memberNetworkId : otherMemberNetworkId;
                vm.prank(registry.networkMemberAuthAddress(id));
                issuerSet.retireIssuerKey(id, publishedLeaf[pick]);
                keyOwner[pick] = 0;
            }
        }

        // The reference's empty case (root 0) only matches the contract's "never written" case, so
        // guarantee at least one write happened.
        if (!everPublished) _publish(memberNetworkId, 0);

        uint256[] memory leaves = issuerSet.getLeaves(0, issuerSet.getLeafCount());
        assertEq(issuerSet.issuerSetRoot(), _referenceRoot(leaves));
    }

    /// @dev The circuit's `binary_merkle_root` verification loop, replayed in Solidity: fold `index`'s
    /// siblings back up to a root, packed by `pathIndex`, and check it against {issuerSetRoot}. A
    /// tampered or misordered sibling, or a wrong direction bit, from {siblingsOf} would fail this the
    /// same way it would fail circuit verification.
    function testFuzz_SiblingsOpenToTheRoot(uint8 rawKeyCount, uint256 rawIndex) public {
        uint256 keyCount = bound(rawKeyCount, 1, issuerSet.MAX_ISSUER_KEYS_PER_MEMBER());
        _approveMember(memberNetworkId);

        for (uint256 i = 0; i < keyCount; ++i) {
            _publish(memberNetworkId, i);
        }

        uint256 index = bound(rawIndex, 0, keyCount - 1);
        uint256 node = issuerSet.getLeaf(index);
        (uint256[] memory siblings, uint256 pathIndex) = issuerSet.siblingsOf(index);

        for (uint256 level; level < siblings.length; ++level) {
            bool isRightChild = (pathIndex >> level) & 1 == 1;
            node = isRightChild
                ? IssuerSetHashes.internalNode(siblings[level], node)
                : IssuerSetHashes.internalNode(node, siblings[level]);
        }

        assertEq(node, issuerSet.issuerSetRoot());
    }

    /// @dev Mirrors `testFuzz_RootMatchesTheReferenceConstruction`'s random publish/retire history,
    /// then folds every still-live slot's witness to the root — the promoted-tombstone case a
    /// publish-only history like `testFuzz_SiblingsOpenToTheRoot`'s can never reach, since a tombstone
    /// only exists once something has been retired.
    function testFuzz_SiblingsOpenToTheRootAcrossAPublishAndRetireHistory(uint256 seed) public {
        _approveMember(memberNetworkId);
        _approveMember(otherMemberNetworkId);

        // 0 = unowned, 1 = held live by `memberNetworkId`, 2 = held live by `otherMemberNetworkId`.
        uint8[10] memory keyOwner;
        uint256[10] memory publishedLeaf;
        // The physical slot each key landed at, distinct from `pick`: publication appends at
        // `leafCount`, so a key's tree position tracks insertion order, not its identity.
        uint256[10] memory publishedIndex;
        bool everPublished;

        for (uint256 step; step < 24; ++step) {
            uint256 rand = uint256(keccak256(abi.encodePacked(seed, step)));

            if (rand % 2 == 0) {
                uint256 pick = _findByOwner(keyOwner, rand, 0);
                if (pick == type(uint256).max) continue;

                bool useFirstMember = (rand >> 8) % 2 == 0;
                bytes32 id = useFirstMember ? memberNetworkId : otherMemberNetworkId;

                if (issuerSet.issuerKeysOf(id).length >= issuerSet.MAX_ISSUER_KEYS_PER_MEMBER()) {
                    useFirstMember = !useFirstMember;
                    id = useFirstMember ? memberNetworkId : otherMemberNetworkId;
                    if (issuerSet.issuerKeysOf(id).length >= issuerSet.MAX_ISSUER_KEYS_PER_MEMBER()) continue;
                }

                publishedLeaf[pick] = _publish(id, pick);
                publishedIndex[pick] = issuerSet.getLeafCount() - 1;
                keyOwner[pick] = useFirstMember ? 1 : 2;
                everPublished = true;
            } else {
                uint256 pick = _findByOwner(keyOwner, rand, 1);
                if (pick == type(uint256).max) continue;

                bytes32 id = keyOwner[pick] == 1 ? memberNetworkId : otherMemberNetworkId;
                vm.prank(registry.networkMemberAuthAddress(id));
                issuerSet.retireIssuerKey(id, publishedLeaf[pick]);
                keyOwner[pick] = 0;
            }
        }

        if (!everPublished) {
            _publish(memberNetworkId, 0);
            publishedIndex[0] = issuerSet.getLeafCount() - 1;
            keyOwner[0] = 1;
        }

        uint256 root = issuerSet.issuerSetRoot();
        for (uint256 i; i < 10; ++i) {
            if (keyOwner[i] == 0) continue;

            uint256 index = publishedIndex[i];
            uint256 node = issuerSet.getLeaf(index);
            (uint256[] memory siblings, uint256 pathIndex) = issuerSet.siblingsOf(index);

            for (uint256 level; level < siblings.length; ++level) {
                bool isRightChild = (pathIndex >> level) & 1 == 1;
                node = isRightChild
                    ? IssuerSetHashes.internalNode(siblings[level], node)
                    : IssuerSetHashes.internalNode(node, siblings[level]);
            }

            assertEq(node, root);
        }
    }

    /// @dev The first slot in `keyOwner` starting from `(rand + i) % 10` whose owner equals `want`, or
    /// `type(uint256).max` if none match.
    function _findByOwner(uint8[10] memory keyOwner, uint256 rand, uint8 want) private pure returns (uint256) {
        for (uint256 i; i < 10; ++i) {
            uint256 candidate = (rand + i) % 10;
            if (keyOwner[candidate] == want) return candidate;
        }

        return type(uint256).max;
    }

    /// @dev The LeanIMT parent rule, applied literally and independently of the contract: pairwise-hash
    /// the current level, promoting an unpaired last node unchanged instead of hashing it against a
    /// zero pad, until one node remains.
    function _referenceRoot(uint256[] memory leaves) private pure returns (uint256) {
        uint256 width = leaves.length;
        if (width == 0) return 0;

        uint256[] memory level = leaves;
        while (width > 1) {
            uint256 nextWidth = (width + 1) / 2;
            uint256[] memory next = new uint256[](nextWidth);

            for (uint256 i; i < nextWidth; ++i) {
                uint256 left = level[2 * i];
                next[i] = 2 * i + 1 < width ? IssuerSetHashes.internalNode(left, level[2 * i + 1]) : left;
            }

            level = next;
            width = nextWidth;
        }

        return level[0];
    }
}
