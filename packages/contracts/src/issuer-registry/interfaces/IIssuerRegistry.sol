// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IIssuerRegistry
/// @notice The deployable issuer registry service: anyone can create a registry, and superseded roots stay
/// acceptable for a bounded window.
interface IIssuerRegistry {
    /// @dev `rootAtExpiry` was current when {expireRegistryRoots} last ran, so a write later in the same
    /// block does not take its window away.
    struct Registry {
        uint256 rootDuration;
        uint256 rootsExpiredAt;
        uint256 rootAtExpiry;
        mapping(uint256 issuerRoot => uint256 supersededAt) rootSupersededAt;
    }

    event RegistryRootDurationUpdated(uint256 indexed registryId, uint256 oldRootDuration, uint256 newRootDuration);

    event RegistryRootsExpired(uint256 indexed registryId);

    function registryCounter() external view returns (uint256);

    function createRegistry() external returns (uint256 registryId);

    function createRegistry(address admin) external returns (uint256 registryId);

    /// @param rootDuration How long a superseded root stays acceptable, in seconds.
    function createRegistry(address admin, uint256 rootDuration) external returns (uint256 registryId);

    function updateRegistryAdmin(uint256 registryId, address newAdmin) external;

    function acceptRegistryAdmin(uint256 registryId) external;

    /// @dev Applies to every past root not closed by {expireRegistryRoots}.
    function updateRegistryRootDuration(uint256 registryId, uint256 newRootDuration) external;

    /// @notice Rejects every root superseded so far. Use after removing a compromised issuer.
    function expireRegistryRoots(uint256 registryId) external;

    function addIssuer(uint256 registryId, uint256 issuerCommitment) external;

    function addIssuers(uint256 registryId, uint256[] calldata issuerCommitments) external;

    /// @notice Zeroes the issuer's leaf.
    /// @param siblingNodes The commitment's Merkle siblings against the current root.
    function removeIssuer(uint256 registryId, uint256 issuerCommitment, uint256[] calldata siblingNodes) external;

    /// @notice Replaces an issuer's commitment in place.
    /// @param siblingNodes The old commitment's Merkle siblings against the current root.
    function updateIssuerCommitment(
        uint256 registryId,
        uint256 oldIssuerCommitment,
        uint256 newIssuerCommitment,
        uint256[] calldata siblingNodes
    ) external;

    /// @notice Whether a proof's root is accepted: the current non-empty root, or one superseded less than
    /// `rootDuration` ago and after the last {expireRegistryRoots}.
    function isValidRoot(uint256 registryId, uint256 issuerRoot) external view returns (bool);

    /// @notice Zero for the current root and unknown roots.
    function getRootSupersededAt(uint256 registryId, uint256 issuerRoot) external view returns (uint256);

    function getRegistryRootDuration(uint256 registryId) external view returns (uint256);

    function getRegistryRootsExpiredAt(uint256 registryId) external view returns (uint256);
}
