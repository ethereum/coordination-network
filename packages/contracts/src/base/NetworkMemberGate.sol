// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

/// @title NetworkMemberGate
/// @notice Gates functions on an anonymous Semaphore membership proof from an approved network
/// member, bound to the call it authorises.
/// @dev A gated call learns that it came from some approved network member and nothing else. Nothing
/// here reads `msg.sender`, so the call can be submitted from a stealth address and relayed by a
/// paymaster.
///
/// This contract is only the gate. It does not create the approved-member group, admit members,
/// remove them or hold any membership state: the group is created on the Semaphore deployment by
/// `NetworkMemberGroup` and administered by governance, and this contract is pointed at it by id at
/// construction.
/// Everything about the proof lifecycle is likewise Semaphore's: membership, the recent-root window
/// (the group's Merkle tree duration) and the nullifier set that stops a proof being submitted
/// twice.
///
/// What the gate adds is the binding: the Semaphore message is not accepted from the caller at all,
/// it is derived from the gated call's own arguments, so a proof authorises exactly one call and a
/// proof repurposed for another payload simply fails verification.
abstract contract NetworkMemberGate {
    /// @notice A membership proof authorising one call.
    /// @dev Semaphore's proof without its message field. The message is the one public signal the
    /// caller does not supply, because the gated function derives it.
    struct NetworkMemberProof {
        uint256 merkleTreeDepth;
        uint256 merkleTreeRoot;
        uint256 nullifier;
        uint256 scope;
        uint256[8] points;
    }

    /// @notice The Semaphore deployment holding the approved-member group.
    ISemaphore public immutable SEMAPHORE;

    /// @notice The approved-member group this contract gates on.
    uint256 public immutable NETWORK_MEMBER_GROUP_ID;

    /// @dev Gates a function on a membership proof over `message`. The message is derived from the
    /// call's own arguments, so the expression passed here is evaluated before the proof is checked.
    /// @param message The call the proof must authorise.
    /// @param proof The network member's Semaphore proof.
    modifier onlyNetworkMember(uint256 message, NetworkMemberProof calldata proof) {
        _validateNetworkMemberProof(message, proof);
        _;
    }

    /// @param semaphore The Semaphore deployment holding the approved-member group.
    /// @param networkMemberGroupId The group to gate on. It must already exist, and governance must
    /// be its admin; creating it and maintaining its membership happen outside this contract.
    constructor(ISemaphore semaphore, uint256 networkMemberGroupId) {
        SEMAPHORE = semaphore;
        NETWORK_MEMBER_GROUP_ID = networkMemberGroupId;
    }

    /// @dev Hands the proof to Semaphore with `message` as its message, which verifies membership
    /// against a live root of the group and burns the nullifier so the proof cannot be submitted
    /// again. A proof generated for a different call carries a different message and fails
    /// verification here.
    /// @param message The call the proof must authorise.
    /// @param proof The network member's Semaphore proof.
    function _validateNetworkMemberProof(uint256 message, NetworkMemberProof calldata proof) internal {
        SEMAPHORE.validateProof(
            NETWORK_MEMBER_GROUP_ID,
            ISemaphore.SemaphoreProof({
                merkleTreeDepth: proof.merkleTreeDepth,
                merkleTreeRoot: proof.merkleTreeRoot,
                nullifier: proof.nullifier,
                message: message,
                scope: proof.scope,
                points: proof.points
            })
        );
    }
}
