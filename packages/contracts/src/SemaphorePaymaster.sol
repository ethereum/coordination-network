// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { BasePaymaster } from "@account-abstraction/contracts/core/BasePaymaster.sol";
import { PackedUserOperation } from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import { _packValidationData } from "@account-abstraction/contracts/core/Helpers.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Semaphore } from "@semaphore-protocol/contracts/Semaphore.sol";
import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import { ISemaphoreVerifier } from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";
import { MIN_DEPTH, MAX_DEPTH } from "@semaphore-protocol/contracts/base/Constants.sol";

/**
 * @title SemaphorePaymaster
 * @notice A paymaster that validates user operations in a privacy preserving way using a single semaphore group
 */
contract SemaphorePaymaster is BasePaymaster, Semaphore {
    /**
     * The paymaster uses a single Semaphore group
     */
    uint256 public immutable GROUP_ID;

    /**
     * `ISemaphore.SemaphoreProof` has a fixed length: five initial fields & exactly eight points
     */
    uint256 private constant ENCODED_PROOF_LENGTH = 13 * 32;

    /**
     * `preVerificationGas` is self declared and never refunded, so `maxCost` can be used to drain the paymaster
     */
    uint256 public immutable MAX_COST_PER_OP;

    error ZeroOwner();

    constructor(address _entryPoint, address _verifier, address _owner, uint256 _maxCostPerOp)
        BasePaymaster(IEntryPoint(_entryPoint))
        Semaphore(ISemaphoreVerifier(_verifier))
    {
        MAX_COST_PER_OP = _maxCostPerOp;

        // _transferOwnership skips zero-address guard
        if (_owner == address(0)) revert ZeroOwner();

        // BasePaymaster calls Ownable(msg.sender) — we want to set our own owner.
        _transferOwnership(_owner);

        // same logic as Semaphore.sol function `function createGroup(address) external;`
        GROUP_ID = groupCounter++;
        _createGroup(GROUP_ID, _owner);
        groups[GROUP_ID].merkleTreeDuration = 1 hours;
    }

    /**
     * Validate a user operation by verifying a Semaphore proof.
     * @dev  Call `verifier.verifyProof` directly to avoid banned `block.timestamp` opcode
     * @param userOp        - The user operation.
     * @param // userOpHash - The hash of the user operation.
     * @param maxCost       - The maximum cost of the user operation.
     */
    function _validatePaymasterUserOp(
        PackedUserOperation calldata userOp,
        bytes32,
        /* userOpHash */
        uint256 maxCost
    )
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        if (maxCost > MAX_COST_PER_OP) {
            return ("", _packValidationData(true, 0, 0));
        }

        bytes calldata encodedProof = userOp.paymasterAndData[PAYMASTER_DATA_OFFSET:];
        if (encodedProof.length != ENCODED_PROOF_LENGTH) {
            return ("", _packValidationData(true, 0, 0));
        }

        ISemaphore.SemaphoreProof memory proof = abi.decode(encodedProof, (ISemaphore.SemaphoreProof));

        // message & scope must be the sender address. message binds the proof to the account
        // being sponsored. scope does the same, and ensures Semaphore nullifiers are unique per
        // account, since nullifier = hash(scope, secret) — a stable scope would link
        // multiple stealth accounts to a single semaphore identity.
        uint256 expectedSender = uint256(uint160(userOp.sender));
        if (proof.message != expectedSender || proof.scope != expectedSender) {
            return ("", _packValidationData(true, 0, 0));
        }

        // Validation will fail if the Merkle tree depth is not supported.
        if (proof.merkleTreeDepth < MIN_DEPTH || proof.merkleTreeDepth > MAX_DEPTH) {
            return ("", _packValidationData(true, 0, 0));
        }

        // Gets the number of leaves in the Incremental Merkle Tree that represents the group
        // with id groupId which is the same as the number of members in the group groupId.
        uint256 merkleTreeSize = getMerkleTreeSize(GROUP_ID);

        // Validation will fail if there are no members in the group.
        if (merkleTreeSize == 0) {
            return ("", _packValidationData(true, 0, 0));
        }

        // A superseded root is valid until its `merkleTreeDuration` window ends, so this becomes
        // userOp validUntil.
        uint48 validUntil = 0;

        // Gets the Merkle root of the Incremental Merkle Tree that represents the group with id groupId.
        uint256 currentMerkleTreeRoot = getMerkleTreeRoot(GROUP_ID);

        // A proof could have used an old Merkle tree root.
        // https://github.com/semaphore-protocol/semaphore/issues/98
        if (proof.merkleTreeRoot != currentMerkleTreeRoot) {
            uint256 merkleRootSupersededDate = groups[GROUP_ID].merkleRootSupersededDates[proof.merkleTreeRoot];
            uint256 merkleTreeDuration = groups[GROUP_ID].merkleTreeDuration;

            // A zero duration would otherwise make `validUntil` 0, which ERC-4337 reads as "never expires"
            if (merkleRootSupersededDate == 0 || merkleTreeDuration == 0) {
                return ("", _packValidationData(true, 0, 0));
            }

            // Semaphore's window end is exclusive, `validUntil` is inclusive
            validUntil = SafeCast.toUint48(merkleRootSupersededDate + merkleTreeDuration - 1);
        }

        // Call `verifier.verifyProof` directly. `this.verifyProof` reads `block.timestamp` when the
        // proof `merkleTreeRoot` does not match `currentMerkleTreeRoot`, which ERC-7562 bans.
        bool verified = verifier.verifyProof(
            [proof.points[0], proof.points[1]],
            [[proof.points[2], proof.points[3]], [proof.points[4], proof.points[5]]],
            [proof.points[6], proof.points[7]],
            [proof.merkleTreeRoot, proof.nullifier, _hashToField(proof.message), _hashToField(proof.scope)],
            proof.merkleTreeDepth
        );
        if (!verified) {
            return ("", _packValidationData(true, 0, 0));
        }

        return ("", _packValidationData(false, validUntil, 0));
    }

    /**
     * Same logic as `Semaphore.sol`'s `_hash`, which is private so cannot be called here.
     */
    function _hashToField(uint256 message) private pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(message))) >> 8;
    }
}
