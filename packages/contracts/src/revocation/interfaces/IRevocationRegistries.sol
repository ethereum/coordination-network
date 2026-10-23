// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IRevocationRegistries
/// @notice Interface of the base contract that owns the revocation trees.
/// @dev Every revocation registry is one LeanIMT+ whose leaves are the revocation commitments of
/// revoked credentials, plus an admin allowed to write to it. A credential is proven unrevoked with
/// a non-membership proof against the registry's root.
interface IRevocationRegistries {
    error RegistryDoesNotExist();
    error CallerIsNotTheRegistryAdmin();
    error CallerIsNotThePendingRegistryAdmin();
    error ZeroAdmin();

    /// @notice Emitted when a registry is created.
    /// @param registryId The id of the new registry.
    event RegistryCreated(uint256 indexed registryId);

    /// @notice Emitted when a registry admin change takes effect.
    /// @param registryId The id of the registry.
    /// @param oldAdmin The previous admin.
    /// @param newAdmin The new admin.
    event RegistryAdminUpdated(uint256 indexed registryId, address indexed oldAdmin, address indexed newAdmin);

    /// @notice Emitted when a registry admin change is proposed and awaits acceptance.
    /// @param registryId The id of the registry.
    /// @param oldAdmin The current admin.
    /// @param newAdmin The proposed admin.
    event RegistryAdminPending(uint256 indexed registryId, address indexed oldAdmin, address indexed newAdmin);

    /// @notice Emitted when a credential is revoked.
    /// @param registryId The id of the registry.
    /// @param index The physical leaf index the commitment was written to.
    /// @param revocationCommitment The revoked commitment.
    /// @param revocationRoot The new root of the registry.
    event CredentialRevoked(
        uint256 indexed registryId, uint256 index, uint256 revocationCommitment, uint256 revocationRoot
    );

    /// @notice Emitted when several credentials are revoked in one call.
    /// @param registryId The id of the registry.
    /// @param revocationCommitments The revoked commitments, in insertion order.
    /// @param revocationRoot The new root of the registry.
    event CredentialsRevoked(uint256 indexed registryId, uint256[] revocationCommitments, uint256 revocationRoot);

    /// @notice Emitted when a revocation is undone.
    /// @param registryId The id of the registry.
    /// @param index The physical leaf index that was tombstoned.
    /// @param revocationCommitment The commitment that is no longer revoked.
    /// @param revocationRoot The new root of the registry.
    event CredentialUnrevoked(
        uint256 indexed registryId, uint256 index, uint256 revocationCommitment, uint256 revocationRoot
    );

    /// @notice Emitted when a revoked commitment is replaced in place.
    /// @param registryId The id of the registry.
    /// @param index The physical leaf index that was rewritten.
    /// @param oldRevocationCommitment The commitment that was replaced.
    /// @param newRevocationCommitment The commitment that took its place.
    /// @param revocationRoot The new root of the registry.
    event RevocationCommitmentUpdated(
        uint256 indexed registryId,
        uint256 index,
        uint256 oldRevocationCommitment,
        uint256 newRevocationCommitment,
        uint256 revocationRoot
    );

    /// @notice Returns the admin of a registry, or the zero address if the registry does not exist.
    /// @param registryId The id of the registry.
    /// @return The registry admin.
    function getRegistryAdmin(uint256 registryId) external view returns (address);

    /// @notice Returns the admin that has been proposed for a registry but has not accepted yet.
    /// @param registryId The id of the registry.
    /// @return The pending registry admin, or the zero address if there is none.
    function getPendingRegistryAdmin(uint256 registryId) external view returns (address);

    /// @notice Whether a credential has been revoked.
    /// @param registryId The id of the registry.
    /// @param revocationCommitment The revocation commitment of the credential.
    /// @return True if the commitment is in the registry.
    function isRevoked(uint256 registryId, uint256 revocationCommitment) external view returns (bool);

    /// @notice Returns the physical leaf index of a revoked commitment. Reverts if it is not revoked.
    /// @param registryId The id of the registry.
    /// @param revocationCommitment The revocation commitment of the credential.
    /// @return The physical leaf index.
    function indexOf(uint256 registryId, uint256 revocationCommitment) external view returns (uint256);

    /// @notice Returns the indexed leaf stored at a physical index, as `(value, nextValue)`.
    /// @dev Reading every slot from `0` to {getRevocationTreeLeafCount} minus one yields the whole
    /// registry, which is what a holder rebuilds the tree from, so the registry stays usable even if
    /// no indexer or snapshot service is available. Reverts if `index` is out of range.
    /// @param registryId The id of the registry.
    /// @param index The physical leaf index.
    /// @return value The commitment stored at the index, or zero for the sentinel and tombstones.
    /// @return nextValue The next commitment in sorted order, or zero at the tail.
    function getLeaf(uint256 registryId, uint256 index) external view returns (uint256 value, uint256 nextValue);

    /// @notice Returns the current revocation root of a registry. Zero while the registry is empty.
    /// @param registryId The id of the registry.
    /// @return The current root.
    function getRevocationRoot(uint256 registryId) external view returns (uint256);

    /// @notice Returns the depth of a registry's tree.
    /// @param registryId The id of the registry.
    /// @return The tree depth.
    function getRevocationTreeDepth(uint256 registryId) external view returns (uint256);

    /// @notice Returns the number of revoked commitments in a registry, excluding the sentinel and
    /// any tombstones.
    /// @param registryId The id of the registry.
    /// @return The number of revoked commitments.
    function getRevocationTreeSize(uint256 registryId) external view returns (uint256);

    /// @notice Returns the number of physical leaf slots, including the sentinel and tombstones.
    /// @dev This is the upper bound for {getLeaf}, not the number of revocations.
    /// @param registryId The id of the registry.
    /// @return The number of leaf slots.
    function getRevocationTreeLeafCount(uint256 registryId) external view returns (uint256);
}
