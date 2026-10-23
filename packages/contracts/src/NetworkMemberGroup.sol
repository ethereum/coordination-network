// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import { ISemaphoreGroups } from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

/// @title NetworkMemberGroup
/// @notice The Semaphore group of approved network members. Owns nothing but the membership: who a
/// member is lives in the NetworkMemberRegistry, and the group is created here at deployment.
/// @dev The group is created on the Semaphore deployment in this contract's constructor, with this
/// contract as its admin, so membership can only ever change through the two governance-gated calls
/// below. The owner is the governance Safe, which makes a quorum of approved network members the
/// only party that can add or remove a member.
///
/// Everything about the group beyond membership belongs to Semaphore: the tree, the root history and
/// its duration, proof verification, and the nullifier set. Consumers that gate on membership read
/// the group by id from the Semaphore deployment and never need this contract, which is why {GROUP_ID}
/// and {SEMAPHORE} are public.
contract NetworkMemberGroup is Ownable2Step {
    /// @notice The Semaphore deployment holding the group.
    ISemaphore public immutable SEMAPHORE;

    /// @notice The approved-network-member group, created at deployment.
    uint256 public immutable GROUP_ID;

    event NetworkMemberAdded(uint256 identityCommitment);
    event NetworkMemberRemoved(uint256 identityCommitment);

    /// @param semaphore The Semaphore deployment to create the group on.
    /// @param governance The governance Safe. It becomes the owner, and the sole writer.
    constructor(ISemaphore semaphore, address governance) Ownable(governance) {
        SEMAPHORE = semaphore;
        GROUP_ID = semaphore.createGroup(address(this));
    }

    /// @notice Adds an approved network member's Semaphore identity commitment to the group.
    /// @dev Callable only by the governance Safe, so a member joins the group under the same quorum
    /// that admitted it to the registry. Semaphore rejects a zero commitment, one outside the SNARK
    /// scalar field, and a duplicate.
    /// @param identityCommitment The member's Semaphore identity commitment.
    function addNetworkMember(uint256 identityCommitment) external onlyOwner {
        SEMAPHORE.addMember(GROUP_ID, identityCommitment);

        emit NetworkMemberAdded(identityCommitment);
    }

    /// @notice Removes a network member's commitment from the group.
    /// @param identityCommitment The commitment to remove.
    /// @param merkleProofSiblings The sibling nodes proving the commitment is in the group, computed
    /// off chain against the group state this transaction will execute in.
    function removeNetworkMember(uint256 identityCommitment, uint256[] calldata merkleProofSiblings)
        external
        onlyOwner
    {
        SEMAPHORE.removeMember(GROUP_ID, identityCommitment, merkleProofSiblings);

        emit NetworkMemberRemoved(identityCommitment);
    }

    /// @notice Whether a commitment is currently in the group.
    /// @param identityCommitment The commitment to look up.
    /// @return True if the commitment is a member.
    function hasNetworkMember(uint256 identityCommitment) external view returns (bool) {
        return ISemaphoreGroups(address(SEMAPHORE)).hasMember(GROUP_ID, identityCommitment);
    }

    /// @notice The group's current Merkle root, the value a membership proof is checked against.
    /// @return The current root.
    function merkleTreeRoot() external view returns (uint256) {
        return ISemaphoreGroups(address(SEMAPHORE)).getMerkleTreeRoot(GROUP_ID);
    }
}
