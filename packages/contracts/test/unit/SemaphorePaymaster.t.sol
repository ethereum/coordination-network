// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { _packValidationData, SIG_VALIDATION_FAILED } from "@account-abstraction/contracts/core/Helpers.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import { MIN_DEPTH, MAX_DEPTH } from "@semaphore-protocol/contracts/base/Constants.sol";

import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";
import { SemaphorePaymasterTestBase } from "../utils/SemaphorePaymasterTestBase.sol";

contract SemaphorePaymasterUnitTest is SemaphorePaymasterTestBase {
    function test_Constructor_SetsOwnerEntryPointAndGroup() public {
        SemaphorePaymaster newSemaphorePaymaster =
            new SemaphorePaymaster(address(entryPoint), address(semaphoreVerifier), owner, MAX_COST_PER_OP);

        assertEq(newSemaphorePaymaster.owner(), owner, "Owner should be set immediately, not pending");
        assertEq(address(newSemaphorePaymaster.entryPoint()), address(entryPoint), "EntryPoint should be set");
        assertEq(
            newSemaphorePaymaster.getGroupAdmin(newSemaphorePaymaster.GROUP_ID()), owner, "Owner should be group admin"
        );
    }

    function test_constructor_SetsTheGroupsRootWindow() public view {
        uint256 groupId = semaphorePaymaster.GROUP_ID();

        uint256 merkleTreeDuration = semaphorePaymaster.groups(groupId);

        assertEq(merkleTreeDuration, MERKLE_TREE_DURATION);
    }

    function test_Constructor_RevertsWhen_OwnerZero() public {
        vm.expectRevert(SemaphorePaymaster.ZeroOwner.selector);
        new SemaphorePaymaster(address(entryPoint), address(semaphoreVerifier), address(0), MAX_COST_PER_OP);
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_MaxCostAboveOpCap() public {
        _addNetworkMembers();

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, validProof, MAX_COST_PER_OP + 1);

        assertEq(validationData, SIG_VALIDATION_FAILED, "A userOp costing more than the per op cap must be rejected");
    }

    function test_ValidatePaymasterUserOp_SucceedsWhen_MaxCostAtOpCap() public {
        _addNetworkMembers();

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, validProof, MAX_COST_PER_OP);

        assertEq(validationData, 0, "A userOp costing exactly the per op cap must be sponsored");
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_PaymasterDataMalformed() public {
        _addNetworkMembers();

        bytes memory malformedProof = hex"deadbeef";

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, malformedProof, MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "Malformed paymaster data must not revert validation");
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_ProofBoundToDifferentSender() public {
        _addNetworkMembers();

        (, uint256 validationData) = _validatePaymasterUserOp(sender2, validProof, MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "Proof for sender1 must not sponsor sender2");
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_ScopeIsNotSender() public {
        _addNetworkMembers();

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, wrongScopeProof, MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "Scope must equal the sender");
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_MerkleTreeDepthUnsupported() public {
        _addNetworkMembers();

        ISemaphore.SemaphoreProof memory tamperedProof = abi.decode(validProof, (ISemaphore.SemaphoreProof));
        tamperedProof.merkleTreeDepth = MAX_DEPTH + 1;

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, abi.encode(tamperedProof), MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "An unsupported tree depth must not revert validation");
    }

    function test_validatePaymasterUserOp_RejectsWhen_MerkleTreeDepthBelowMinimum() public {
        _addNetworkMembers();
        ISemaphore.SemaphoreProof memory belowMinimumDepthProof = abi.decode(validProof, (ISemaphore.SemaphoreProof));
        belowMinimumDepthProof.merkleTreeDepth = MIN_DEPTH - 1;

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, abi.encode(belowMinimumDepthProof), MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED);
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_GroupHasNoMembers() public {
        (, uint256 validationData) = _validatePaymasterUserOp(sender1, validProof, MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "An empty group must not revert validation");
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_ProofFromUnknownGroup() public {
        _addNetworkMembers();

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, nonMemberProof, MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "A root outside the group must not revert validation");
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_ProofTampered() public {
        _addNetworkMembers();

        ISemaphore.SemaphoreProof memory tamperedProof = abi.decode(validProof, (ISemaphore.SemaphoreProof));
        tamperedProof.nullifier = tamperedProof.nullifier + 1;

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, abi.encode(tamperedProof), MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "Tampered proof must fail verification");
    }

    function test_ValidatePaymasterUserOp_SucceedsWithValidProof() public {
        _addNetworkMembers();

        (bytes memory context, uint256 validationData) = _validatePaymasterUserOp(sender1, validProof, MAX_COST);

        assertEq(validationData, 0, "Validation should succeed");
        assertEq(context.length, 0, "An empty context tells the EntryPoint to skip postOp");
    }

    function test_ValidatePaymasterUserOp_RejectsWhen_SupersededRootAndDurationZero() public {
        _addNetworkMembers();
        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.updateGroupMerkleTreeDuration(groupId, 0);

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, supersededRootProof, MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "A zero duration must reject every superseded root");
    }

    function test_ValidatePaymasterUserOp_RevertsWhen_SupersededRootWindowWouldTruncateValidUntilToZero() public {
        _addNetworkMembers();
        uint256 windowEndTruncatingToZero = uint256(type(uint48).max) + 1;
        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.updateGroupMerkleTreeDuration(groupId, windowEndTruncatingToZero + 1 - block.timestamp);

        vm.expectRevert(
            abi.encodeWithSelector(
                SafeCast.SafeCastOverflowedUintDowncast.selector, SAFE_CAST_TARGET_BITS, windowEndTruncatingToZero
            )
        );
        _validatePaymasterUserOp(sender1, supersededRootProof, MAX_COST);
    }

    function test_ValidatePaymasterUserOp_SucceedsWhen_SupersededRootWindowEndsAtUint48Max() public {
        _addNetworkMembers();
        uint256 durationEndingAtUint48Max = uint256(type(uint48).max) + 1 - block.timestamp;
        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.updateGroupMerkleTreeDuration(groupId, durationEndingAtUint48Max);

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, supersededRootProof, MAX_COST);

        uint256 expectedValidationData = _packValidationData(false, type(uint48).max, 0);
        assertEq(validationData, expectedValidationData, "The largest window uint48 can hold must still be accepted");
    }

    function test_ValidatePaymasterUserOp_SucceedsWithSupersededRootWithinDuration() public {
        _addNetworkMembers();

        // `supersededRootProof` root is a one member tree. `_addNetworkMembers()` adds a
        // second member too, which changes the root from what proof expects
        (, uint256 validationData) = _validatePaymasterUserOp(sender1, supersededRootProof, MAX_COST);

        uint256 expectedValidationData =
            _packValidationData(false, uint48(block.timestamp + MERKLE_TREE_DURATION - 1), 0);
        assertEq(
            validationData,
            expectedValidationData,
            "Superseded root should be valid until its `merkleTreeDuration` window ends"
        );
    }
}
