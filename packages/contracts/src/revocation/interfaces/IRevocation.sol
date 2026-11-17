// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IRevocation
/// @notice The deployable revocation service: anyone can create a registry, and superseded roots
/// stay acceptable for a bounded window so that proofs in flight survive a new revocation.
interface IRevocation {
    /// @dev `rootSupersededAt` maps each past root to when it stopped being current, which starts its
    /// expiry clock.
    struct Registry {
        uint256 rootDuration;
        mapping(uint256 revocationRoot => uint256 supersededAt) rootSupersededAt;
    }

    event RegistryRootDurationUpdated(uint256 indexed registryId, uint256 oldRootDuration, uint256 newRootDuration);

    /// @notice The number of registries created, and the next registry's id.
    function registryCounter() external view returns (uint256);

    /// @notice Creates a registry administered by the caller, with the default root window.
    function createRegistry() external returns (uint256 registryId);

    /// @notice Creates a registry with the default root window.
    function createRegistry(address admin) external returns (uint256 registryId);

    /// @param rootDuration How long a superseded root stays acceptable, in seconds. Zero accepts only
    /// the current root.
    function createRegistry(address admin, uint256 rootDuration) external returns (uint256 registryId);

    /// @notice Proposes a new admin, effective on {acceptRegistryAdmin}.
    function updateRegistryAdmin(uint256 registryId, address newAdmin) external;

    function acceptRegistryAdmin(uint256 registryId) external;

    /// @notice Sets how long superseded roots stay acceptable, in seconds.
    /// @dev Applies to every past root: raising it revives older roots, lowering it invalidates
    /// proofs in flight. It is also how long a revoked credential can keep verifying, so keep it as
    /// short as holders can tolerate. Zero accepts only the current root.
    function updateRegistryRootDuration(uint256 registryId, uint256 newRootDuration) external;

    /// @param lowLeafIndex The physical index of the commitment's predecessor, computed off chain
    /// against the current state.
    function revoke(uint256 registryId, uint256 revocationCommitment, uint256 lowLeafIndex) external;

    /// @param lowLeafIndices Each predecessor index, against the state after the earlier commitments
    /// in the batch are inserted.
    function revokeMany(uint256 registryId, uint256[] calldata revocationCommitments, uint256[] calldata lowLeafIndices)
        external;

    /// @notice Undoes a revocation. The credential becomes valid again, also for verifiers still
    /// accepting an older root.
    /// @param predecessorIndex The physical index of the leaf whose `nextValue` is the commitment.
    function unrevoke(uint256 registryId, uint256 revocationCommitment, uint256 predecessorIndex) external;

    /// @notice Replaces a revoked commitment in place, reusing its slot.
    /// @param newPredecessorIndex The new commitment's predecessor, after the old one is unlinked.
    function updateRevocationCommitment(
        uint256 registryId,
        uint256 oldRevocationCommitment,
        uint256 newRevocationCommitment,
        uint256 oldPredecessorIndex,
        uint256 newPredecessorIndex
    ) external;

    /// @notice Whether a revocation proof's root is accepted now: the current root, or one superseded
    /// less than `rootDuration` seconds ago. This is the only on-chain call a verifier makes.
    function isValidRoot(uint256 registryId, uint256 revocationRoot) external view returns (bool);

    /// @notice When a root stopped being current. Zero for the current root and unknown roots.
    function getRootSupersededAt(uint256 registryId, uint256 revocationRoot) external view returns (uint256);

    /// @notice The accepted-root window, in seconds.
    function getRegistryRootDuration(uint256 registryId) external view returns (uint256);
}
