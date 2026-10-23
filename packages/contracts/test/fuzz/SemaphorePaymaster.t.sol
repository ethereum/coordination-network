// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { _packValidationData, SIG_VALIDATION_FAILED } from "@account-abstraction/contracts/core/Helpers.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { SemaphorePaymasterTestBase } from "../utils/SemaphorePaymasterTestBase.sol";

contract SemaphorePaymasterFuzzTest is SemaphorePaymasterTestBase {
    function testFuzz_ValidatePaymasterUserOp_RejectsWhen_EncodedProofWrongLength(bytes memory encodedProof) public {
        vm.assume(encodedProof.length != 13 * 32);
        _addNetworkMembers();

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, encodedProof, MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "Any wrong length proof must be rejected, not revert");
    }

    function testFuzz_ValidatePaymasterUserOp_RevertsWhen_SupersededRootWindowExceedsUint48(uint256 merkleTreeDuration)
        public
    {
        _addNetworkMembers();
        uint256 min = uint256(type(uint48).max) + 2 - block.timestamp;
        uint256 max = type(uint256).max - block.timestamp;
        merkleTreeDuration = bound(merkleTreeDuration, min, max);
        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.updateGroupMerkleTreeDuration(groupId, merkleTreeDuration);

        vm.expectRevert(
            abi.encodeWithSelector(
                SafeCast.SafeCastOverflowedUintDowncast.selector,
                SAFE_CAST_TARGET_BITS,
                block.timestamp + merkleTreeDuration - 1
            )
        );
        _validatePaymasterUserOp(sender1, supersededRootProof, MAX_COST);
    }

    function testFuzz_ValidatePaymasterUserOp_RejectsWhen_ValidProofPadded(bytes memory padding) public {
        vm.assume(padding.length > 0);
        _addNetworkMembers();

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, abi.encodePacked(validProof, padding), MAX_COST);

        assertEq(validationData, SIG_VALIDATION_FAILED, "Padded proof must be rejected");
    }

    function testFuzz_validatePaymasterUserOp_SupersededRootValidUntilTheWindowEnds(uint256 merkleTreeDuration) public {
        _addNetworkMembers();
        uint256 rootSupersededAt = block.timestamp;
        uint256 longestDurationValidUntilCanHold = uint256(type(uint48).max) + 1 - rootSupersededAt;
        merkleTreeDuration = bound(merkleTreeDuration, 1, longestDurationValidUntilCanHold);
        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.updateGroupMerkleTreeDuration(groupId, merkleTreeDuration);

        (, uint256 validationData) = _validatePaymasterUserOp(sender1, supersededRootProof, MAX_COST);

        uint48 lastValidTimestamp = uint48(rootSupersededAt + merkleTreeDuration - 1);
        uint256 expectedValidationData = _packValidationData(false, lastValidTimestamp, 0);
        assertEq(validationData, expectedValidationData);
    }
}
