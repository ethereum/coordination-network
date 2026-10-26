// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import { ISemaphoreGroups } from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

import { IdentityRegistry } from "../../src/IdentityRegistry.sol";
import { NetworkMemberGate } from "../../src/base/NetworkMemberGate.sol";
import { stdJson } from "forge-std/StdJson.sol";

import { IdentityRegistryTestBase } from "../utils/IdentityRegistryTestBase.sol";

/// @dev The approved-member group and the gate, exercised through the registry that embeds it.
contract NetworkMemberGateUnitTest is IdentityRegistryTestBase {
    using stdJson for string;

    function test_Constructor_PointsAtTheGovernedGroup() public view {
        assertEq(address(identityRegistry.SEMAPHORE()), address(semaphore));
        assertEq(identityRegistry.NETWORK_MEMBER_GROUP_ID(), networkMemberGroupId);
        assertEq(semaphore.getGroupAdmin(networkMemberGroupId), governance);
    }

    function test_Constructor_StoresTheGivenGroupId() public {
        uint256 secondGroupId = semaphore.createGroup(governance);

        IdentityRegistry secondGroupRegistry = new IdentityRegistry(ISemaphore(address(semaphore)), secondGroupId);

        uint256 storedGroupId = secondGroupRegistry.NETWORK_MEMBER_GROUP_ID();
        assertEq(storedGroupId, secondGroupId);
    }

    /// @dev Client and contract must derive update messages identically. The real proofs the other
    /// tests submit already prove it end to end; this pins the shared half with a legible failure.
    function test_UpdateDomainSeparator_MatchesTheClientDerivation() public view {
        assertEq(identityRegistry.UPDATE_DOMAIN_SEPARATOR(), fixtures.readBytes32(".updateDomainSeparator"));
    }

    function test_NetworkMemberGroup_HoldsTheApprovedMembers() public view {
        assertEq(semaphore.getMerkleTreeRoot(networkMemberGroupId), _proof("registerA").merkleTreeRoot);

        for (uint256 i = 0; i < memberCommitments.length; ++i) {
            assertTrue(semaphore.hasMember(networkMemberGroupId, memberCommitments[i]));
        }

        assertFalse(semaphore.hasMember(networkMemberGroupId, newcomerCommitment));
    }

    function test_AddMember_RevertsWhen_CallerIsNotGovernance() public {
        vm.expectRevert(ISemaphoreGroups.Semaphore__CallerIsNotTheGroupAdmin.selector);
        semaphore.addMember(networkMemberGroupId, newcomerCommitment);
    }

    function test_AddMember_AdmitsAMemberAndMovesTheRoot() public {
        uint256 outgoingRoot = semaphore.getMerkleTreeRoot(networkMemberGroupId);

        vm.prank(governance);
        semaphore.addMember(networkMemberGroupId, newcomerCommitment);

        assertTrue(semaphore.hasMember(networkMemberGroupId, newcomerCommitment));
        assertTrue(semaphore.getMerkleTreeRoot(networkMemberGroupId) != outgoingRoot);
    }

    function test_RemoveMember_DropsTheMember() public {
        _removeNetworkMemberCommitment(2);

        assertFalse(semaphore.hasMember(networkMemberGroupId, memberCommitments[2]));
    }

    function test_ValidateProof_RevertsWhen_RootIsNotThisGroups() public {
        NetworkMemberGate.NetworkMemberProof memory proof = _proof("foreignGroupRegisterA");

        vm.expectRevert(ISemaphore.Semaphore__MerkleTreeRootIsNotPartOfTheGroup.selector);
        identityRegistry.registerIdentity(networkIdA, metaA, proof);
    }

    /// @dev A proof generated just before a membership change still lands, which is Semaphore's
    /// recent-root window doing its job.
    function test_ValidateProof_SupersededRootAcceptedInsideTheWindow() public {
        vm.prank(governance);
        semaphore.addMember(networkMemberGroupId, newcomerCommitment);

        vm.warp(block.timestamp + MERKLE_TREE_DURATION - 1);
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        assertEq(identityRegistry.identity(networkIdA), metaA);
    }

    function test_ValidateProof_RevertsWhen_RootExpired() public {
        vm.prank(governance);
        semaphore.addMember(networkMemberGroupId, newcomerCommitment);

        vm.warp(block.timestamp + MERKLE_TREE_DURATION);

        vm.expectRevert(ISemaphore.Semaphore__MerkleTreeRootIsExpired.selector);
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));
    }

    /// @dev Removal bites once the outgoing root expires: from then on the ex-member has no live
    /// root to prove against, and cannot build a proof against the current one.
    function test_ValidateProof_RevertsWhen_MemberWasRemoved() public {
        _removeNetworkMemberCommitment(2);

        vm.warp(block.timestamp + MERKLE_TREE_DURATION);

        vm.expectRevert(ISemaphore.Semaphore__MerkleTreeRootIsExpired.selector);
        identityRegistry.registerIdentity(networkIdB, metaB, _proof("removedMemberRegisterB"));
    }
}
