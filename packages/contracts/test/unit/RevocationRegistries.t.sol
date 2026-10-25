// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { TAG_LEAF } from "@zk-kit/lean-imt-plus.sol/Constants.sol";
import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { PoseidonT4 } from "poseidon-solidity/PoseidonT4.sol";
import { IRevocationRegistries } from "../../src/revocation/interfaces/IRevocationRegistries.sol";
import { RevocationTestBase } from "../utils/RevocationTestBase.sol";

/// @dev Covers the registry-and-tree half of the service: admin gating, the four mutations, and the
/// read surface a holder rebuilds the tree from.
contract RevocationRegistriesTest is RevocationTestBase {
    uint256 internal constant A = 100;
    uint256 internal constant B = 200;
    uint256 internal constant C = 300;

    function test_createRegistry_setsTheCallerAsAdmin() public view {
        assertEq(revocation.getRegistryAdmin(registryId), admin);
        assertEq(revocation.getRevocationRoot(registryId), 0);
        assertEq(revocation.getRevocationTreeSize(registryId), 0);
    }

    function test_getRevocationTreeDepth_ReturnsTreeDepthAfterThreeRevocations() public {
        revoke(registryId, A);
        revoke(registryId, B);
        revoke(registryId, C);
        uint256 depthOfSentinelAndThreeRevocations = 2;

        uint256 depth = revocation.getRevocationTreeDepth(registryId);

        assertEq(depth, depthOfSentinelAndThreeRevocations);
    }

    function test_createRegistry_rejectsTheZeroAdmin() public {
        vm.expectRevert(IRevocationRegistries.ZeroAdmin.selector);
        revocation.createRegistry(address(0));
    }

    function test_revoke_recordsTheCommitmentAndMovesTheRoot() public {
        vm.expectEmit(true, false, false, false);
        emit IRevocationRegistries.CredentialRevoked(registryId, 0, 0, 0);

        revoke(registryId, A);

        assertTrue(revocation.isRevoked(registryId, A));
        assertFalse(revocation.isRevoked(registryId, B));
        assertEq(revocation.getRevocationTreeSize(registryId), 1);
        assertTrue(revocation.getRevocationRoot(registryId) != 0);
    }

    function test_revoke_createsTheSentinelOnTheFirstRevocation() public {
        revoke(registryId, B);

        (uint256 value, uint256 nextValue) = revocation.getLeaf(registryId, 0);

        assertEq(value, 0);
        assertEq(nextValue, B);
        assertEq(revocation.getRevocationTreeLeafCount(registryId), 2);
    }

    function test_revoke_linksLeavesInSortedOrderWhateverTheInsertionOrder() public {
        revoke(registryId, C);
        revoke(registryId, A);
        revoke(registryId, B);

        (, uint256 sentinelNext) = revocation.getLeaf(registryId, 0);
        (uint256 aValue, uint256 aNext) = revocation.getLeaf(registryId, revocation.indexOf(registryId, A));
        (uint256 bValue, uint256 bNext) = revocation.getLeaf(registryId, revocation.indexOf(registryId, B));

        assertEq(sentinelNext, A);
        assertEq(aValue, A);
        assertEq(aNext, B);
        assertEq(bValue, B);
        assertEq(bNext, C);
    }

    function test_revoke_isOnlyForTheRegistryAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IRevocationRegistries.CallerIsNotTheRegistryAdmin.selector);
        revocation.revoke(registryId, A, 0);
    }

    function test_revoke_rejectsAWrongLowLeafIndex() public {
        revoke(registryId, A);
        revoke(registryId, C);

        // Index 0 is the sentinel, whose successor is A, so it is not B's low leaf.
        vm.prank(admin);
        vm.expectRevert();
        revocation.revoke(registryId, B, 0);
    }

    function test_revoke_rejectsADoubleRevocation() public {
        revoke(registryId, A);

        vm.prank(admin);
        vm.expectRevert();
        revocation.revoke(registryId, A, 0);
    }

    function test_revokeMany_matchesRevokingOneByOne() public {
        uint256 batched = revocation.createRegistry(admin);

        uint256[] memory commitments = new uint256[](3);
        uint256[] memory indices = new uint256[](3);
        commitments[0] = C;
        commitments[1] = A;
        commitments[2] = B;
        indices[0] = 0;
        indices[1] = 0; // A sorts below C, so the sentinel is its low leaf.
        indices[2] = 2; // B sorts between A and C, and A landed at index 2.

        vm.prank(admin);
        revocation.revokeMany(batched, commitments, indices);

        revoke(registryId, C);
        revoke(registryId, A);
        revoke(registryId, B);

        assertEq(revocation.getRevocationRoot(batched), revocation.getRevocationRoot(registryId));
        assertEq(revocation.getRevocationTreeSize(batched), 3);
    }

    function test_revokeMany_isOnlyForTheRegistryAdmin() public {
        uint256[] memory commitments = new uint256[](1);
        uint256[] memory indices = new uint256[](1);
        commitments[0] = A;

        vm.prank(stranger);
        vm.expectRevert(IRevocationRegistries.CallerIsNotTheRegistryAdmin.selector);
        revocation.revokeMany(registryId, commitments, indices);
    }

    function test_unrevoke_tombstonesTheSlotAndRelinksTheList() public {
        revoke(registryId, A);
        revoke(registryId, B);
        revoke(registryId, C);

        uint256 index = revocation.indexOf(registryId, B);
        uint256 predecessor = predecessorIndex(registryId, B);

        vm.prank(admin);
        revocation.unrevoke(registryId, B, predecessor);

        (uint256 value, uint256 nextValue) = revocation.getLeaf(registryId, index);
        (, uint256 aNext) = revocation.getLeaf(registryId, revocation.indexOf(registryId, A));

        assertFalse(revocation.isRevoked(registryId, B));
        assertEq(value, 0);
        assertEq(nextValue, 0);
        assertEq(aNext, C);
        assertEq(revocation.getRevocationTreeSize(registryId), 2);
    }

    function test_unrevoke_isOnlyForTheRegistryAdmin() public {
        revoke(registryId, A);

        vm.prank(stranger);
        vm.expectRevert(IRevocationRegistries.CallerIsNotTheRegistryAdmin.selector);
        revocation.unrevoke(registryId, A, 0);
    }

    function test_updateRevocationCommitment_reusesTheSlot() public {
        revoke(registryId, A);
        revoke(registryId, B);

        uint256 index = revocation.indexOf(registryId, B);
        uint256 leafCount = revocation.getRevocationTreeLeafCount(registryId);
        uint256 oldPredecessor = predecessorIndex(registryId, B);
        uint256 newPredecessor = revocation.indexOf(registryId, A);

        vm.prank(admin);
        revocation.updateRevocationCommitment(registryId, B, C, oldPredecessor, newPredecessor);

        assertFalse(revocation.isRevoked(registryId, B));
        assertTrue(revocation.isRevoked(registryId, C));
        assertEq(revocation.indexOf(registryId, C), index);
        assertEq(revocation.getRevocationTreeLeafCount(registryId), leafCount);
    }

    function test_updateRevocationCommitment_isOnlyForTheRegistryAdmin() public {
        revoke(registryId, A);

        vm.prank(stranger);
        vm.expectRevert(IRevocationRegistries.CallerIsNotTheRegistryAdmin.selector);
        revocation.updateRevocationCommitment(registryId, A, B, 0, 0);
    }

    function test_indexOf_revertsForACommitmentThatIsNotRevoked() public {
        revoke(registryId, A);

        vm.expectRevert();
        revocation.indexOf(registryId, B);
    }

    function test_adminTransfer_takesTwoSteps() public {
        vm.prank(admin);
        revocation.updateRegistryAdmin(registryId, stranger);

        assertEq(revocation.getRegistryAdmin(registryId), admin);
        assertEq(revocation.getPendingRegistryAdmin(registryId), stranger);

        vm.prank(stranger);
        revocation.acceptRegistryAdmin(registryId);

        assertEq(revocation.getRegistryAdmin(registryId), stranger);
        assertEq(revocation.getPendingRegistryAdmin(registryId), address(0));
    }

    function test_adminTransfer_isOnlyProposableByTheAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IRevocationRegistries.CallerIsNotTheRegistryAdmin.selector);
        revocation.updateRegistryAdmin(registryId, stranger);
    }

    function test_adminTransfer_isOnlyAcceptableByThePendingAdmin() public {
        vm.prank(admin);
        revocation.updateRegistryAdmin(registryId, stranger);

        vm.expectRevert(IRevocationRegistries.CallerIsNotThePendingRegistryAdmin.selector);
        revocation.acceptRegistryAdmin(registryId);
    }

    /// @dev The leaf commitment is what a rebuilt off-chain tree hashes, so this pins that the
    /// contract stores leaves the revocation-registry package can reproduce. The roots themselves are
    /// compared across languages in test/integration/CrossLanguageRoot.t.sol.
    function test_leavesCommitToTheDomainSeparatedLeafHash() public {
        revoke(registryId, A);

        (uint256 value, uint256 nextValue) = revocation.getLeaf(registryId, 0);
        (uint256 leafValue, uint256 leafNextValue) = revocation.getLeaf(registryId, 1);

        // Two leaves, so the root is the internal hash of their two leaf commitments.
        uint256 root = PoseidonT3.hash(
            [PoseidonT4.hash([value, nextValue, TAG_LEAF]), PoseidonT4.hash([leafValue, leafNextValue, TAG_LEAF])]
        );

        assertEq(revocation.getRevocationRoot(registryId), root);
    }
}
