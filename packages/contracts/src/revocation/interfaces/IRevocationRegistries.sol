// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IRevocationRegistries
/// @notice Revocation registries: one LeanIMT+ of revoked commitments per registry, each with an
/// admin. A credential is proven unrevoked with a non-membership proof against the registry's root.
interface IRevocationRegistries {
    error RegistryDoesNotExist();
    error CallerIsNotTheRegistryAdmin();
    error CallerIsNotThePendingRegistryAdmin();
    error ZeroAdmin();

    event RegistryCreated(uint256 indexed registryId);

    event RegistryAdminUpdated(uint256 indexed registryId, address indexed oldAdmin, address indexed newAdmin);

    /// @notice A proposed admin change, effective once the new admin accepts.
    event RegistryAdminPending(uint256 indexed registryId, address indexed oldAdmin, address indexed newAdmin);

    /// @param index The physical leaf index the commitment was written to.
    event CredentialRevoked(
        uint256 indexed registryId, uint256 index, uint256 revocationCommitment, uint256 revocationRoot
    );

    /// @param revocationCommitments The revoked commitments, in insertion order.
    event CredentialsRevoked(uint256 indexed registryId, uint256[] revocationCommitments, uint256 revocationRoot);

    /// @param index The physical leaf index that was tombstoned.
    event CredentialUnrevoked(
        uint256 indexed registryId, uint256 index, uint256 revocationCommitment, uint256 revocationRoot
    );

    /// @param index The physical leaf index that was rewritten.
    event RevocationCommitmentUpdated(
        uint256 indexed registryId,
        uint256 index,
        uint256 oldRevocationCommitment,
        uint256 newRevocationCommitment,
        uint256 revocationRoot
    );

    /// @notice The registry admin, or the zero address if the registry does not exist.
    function getRegistryAdmin(uint256 registryId) external view returns (address);

    /// @notice The proposed admin that has not accepted yet, or the zero address.
    function getPendingRegistryAdmin(uint256 registryId) external view returns (address);

    function isRevoked(uint256 registryId, uint256 revocationCommitment) external view returns (bool);

    /// @notice The physical leaf index of a revoked commitment. Reverts if it is not revoked.
    function indexOf(uint256 registryId, uint256 revocationCommitment) external view returns (uint256);

    /// @notice The leaf at a physical index. Reading slots `0` to {getRevocationTreeLeafCount} - 1
    /// rebuilds the whole tree off chain, with no indexer needed.
    /// @return value The commitment, or zero for the sentinel and tombstones.
    /// @return nextValue The next commitment in sorted order, or zero at the tail.
    function getLeaf(uint256 registryId, uint256 index) external view returns (uint256 value, uint256 nextValue);

    /// @notice The current root. Zero while the registry is empty.
    function getRevocationRoot(uint256 registryId) external view returns (uint256);

    function getRevocationTreeDepth(uint256 registryId) external view returns (uint256);

    /// @notice The number of revoked commitments, excluding the sentinel and tombstones.
    function getRevocationTreeSize(uint256 registryId) external view returns (uint256);

    /// @notice The number of physical leaf slots, sentinel and tombstones included: the bound for
    /// {getLeaf}.
    function getRevocationTreeLeafCount(uint256 registryId) external view returns (uint256);
}
