// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ISemaphoreGroups } from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";
import { LeafAlreadyExists, LeafCannotBeZero } from "@zk-kit/lean-imt.sol/InternalLeanIMT.sol";

import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract NetworkMemberGroupUnitTest is NetworkMemberRegistryTestBase {
    NetworkMemberGroup internal group;

    function _setUpGroup() internal {
        group = _deployNetworkMemberGroup(owner);
    }

    function test_Constructor_CreatesTheGroupAtDeployment() public {
        _setUpGroup();

        // The group exists from deployment, with the member group itself as its Semaphore admin, so
        // membership can only move through this contract's owner-gated calls.
        assertEq(ISemaphoreGroups(address(group.SEMAPHORE())).getGroupAdmin(group.GROUP_ID()), address(group));
        assertEq(group.merkleTreeRoot(), 0);
        assertEq(group.owner(), owner);
    }

    function test_AddNetworkMember_RevertsWhen_CallerNotGovernance() public {
        _setUpGroup();

        address attacker = makeAddr("attacker");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        group.addNetworkMember(semaphoreCommitment);
    }

    function test_AddNetworkMember_AddsTheCommitment() public {
        _setUpGroup();

        vm.expectEmit();
        emit NetworkMemberGroup.NetworkMemberAdded(semaphoreCommitment);
        vm.prank(owner);
        group.addNetworkMember(semaphoreCommitment);

        assertTrue(group.hasNetworkMember(semaphoreCommitment));
        assertEq(group.merkleTreeRoot(), semaphoreCommitment);
    }

    function test_AddNetworkMember_RevertsWhen_CommitmentAlreadyInTheGroup() public {
        _setUpGroup();
        vm.prank(owner);
        group.addNetworkMember(semaphoreCommitment);

        vm.expectRevert(LeafAlreadyExists.selector);
        vm.prank(owner);
        group.addNetworkMember(semaphoreCommitment);
    }

    function test_AddNetworkMember_RevertsWhen_CommitmentIsZero() public {
        _setUpGroup();

        vm.expectRevert(LeafCannotBeZero.selector);
        vm.prank(owner);
        group.addNetworkMember(0);
    }

    function test_RemoveNetworkMember_RevertsWhen_CallerNotGovernance() public {
        _setUpGroup();
        vm.prank(owner);
        group.addNetworkMember(semaphoreCommitment);

        address attacker = makeAddr("attacker");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        group.removeNetworkMember(semaphoreCommitment, new uint256[](0));
    }

    function test_RemoveNetworkMember_RemovesTheCommitment() public {
        _setUpGroup();
        vm.prank(owner);
        group.addNetworkMember(semaphoreCommitment);

        // A one-leaf tree has depth zero, so the membership proof is empty.
        vm.expectEmit();
        emit NetworkMemberGroup.NetworkMemberRemoved(semaphoreCommitment);
        vm.prank(owner);
        group.removeNetworkMember(semaphoreCommitment, new uint256[](0));

        assertFalse(group.hasNetworkMember(semaphoreCommitment));
    }

    function test_AddNetworkMember_SecondMemberMovesTheRoot() public {
        _setUpGroup();
        vm.prank(owner);
        group.addNetworkMember(semaphoreCommitment);
        uint256 rootAfterFirst = group.merkleTreeRoot();

        uint256 secondCommitment = _semaphoreCommitment("secondMember");
        vm.prank(owner);
        group.addNetworkMember(secondCommitment);

        assertTrue(group.hasNetworkMember(secondCommitment));
        assertTrue(group.merkleTreeRoot() != rootAfterFirst);
    }

    function test_Constructor_EachDeploymentGetsItsOwnGroupId() public {
        _setUpGroup();
        NetworkMemberGroup second = new NetworkMemberGroup(group.SEMAPHORE(), owner);

        assertTrue(second.GROUP_ID() != group.GROUP_ID());
    }

    function test_TransferOwnership_MovesMembershipPowerToTheNewGovernance() public {
        _setUpGroup();
        address newGovernance = makeAddr("newGovernance");

        vm.prank(owner);
        group.transferOwnership(newGovernance);
        vm.prank(newGovernance);
        group.acceptOwnership();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        group.addNetworkMember(semaphoreCommitment);

        vm.prank(newGovernance);
        group.addNetworkMember(semaphoreCommitment);
        assertTrue(group.hasNetworkMember(semaphoreCommitment));
    }
}
