// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IRevocation
/// @notice Interface of the deployable revocation service.
/// @dev {Revocation} adds two things to {RevocationRegistries}: anyone can create a registry and
/// become its admin, and every root a registry has ever published stays acceptable for a bounded
/// window. The window exists because a holder builds a proof against the root they last saw. A
/// revocation landing between proof generation and verification would otherwise invalidate an
/// honest proof.
interface IRevocation {
    /// @notice Per-registry policy.
    /// @dev `rootSupersededAt` is the root history: it maps every root the registry has published
    /// to the block timestamp at which it was superseded, which is when its expiry clock starts.
    struct Registry {
        uint256 rootDuration;
        mapping(uint256 revocationRoot => uint256 supersededAt) rootSupersededAt;
    }

    /// @notice Emitted when a registry's accepted-root window changes.
    /// @param registryId The id of the registry.
    /// @param oldRootDuration The previous window, in seconds.
    /// @param newRootDuration The new window, in seconds.
    event RegistryRootDurationUpdated(uint256 indexed registryId, uint256 oldRootDuration, uint256 newRootDuration);

    /// @notice The number of registries created so far, and the id the next one will get.
    /// @return The registry counter.
    function registryCounter() external view returns (uint256);

    /// @notice Creates a registry administered by the caller, with the default root window.
    /// @return registryId The id of the new registry.
    function createRegistry() external returns (uint256 registryId);

    /// @notice Creates a registry with the default root window.
    /// @param admin The address allowed to revoke in it.
    /// @return registryId The id of the new registry.
    function createRegistry(address admin) external returns (uint256 registryId);

    /// @notice Creates a registry with a custom root window.
    /// @param admin The address allowed to revoke in it.
    /// @param rootDuration How long a superseded root stays acceptable, in seconds. Zero is allowed
    /// and means only the current root is ever accepted.
    /// @return registryId The id of the new registry.
    function createRegistry(address admin, uint256 rootDuration) external returns (uint256 registryId);

    /// @notice Proposes a new admin for a registry. It takes effect on {acceptRegistryAdmin}.
    /// @param registryId The id of the registry.
    /// @param newAdmin The proposed admin.
    function updateRegistryAdmin(uint256 registryId, address newAdmin) external;

    /// @notice Accepts a pending admin transfer.
    /// @param registryId The id of the registry.
    function acceptRegistryAdmin(uint256 registryId) external;

    /// @notice Changes how long a superseded root of a registry stays acceptable.
    /// @dev Shortening the window makes proofs against already superseded roots expire sooner, so
    /// pick a window that comfortably covers how long a holder takes to sync and present. Setting it
    /// to zero turns the grace period off entirely: only the current root is accepted, and every
    /// proof in flight when a revocation lands is invalidated. That is the strictest setting and the
    /// one a registry with adversarial timing concerns wants, at the cost of failed presentations
    /// that an honest holder cannot avoid.
    ///
    /// The new duration applies to every past root of the registry, not only to roots superseded
    /// after this call, so raising it makes older roots valid again and lowering it invalidates
    /// proofs that are already in flight. It is also how long a revoked credential can keep
    /// verifying with an older root, so it should be kept as short as the registry can tolerate.
    /// @param registryId The id of the registry.
    /// @param newRootDuration The new window, in seconds. Zero is allowed.
    function updateRegistryRootDuration(uint256 registryId, uint256 newRootDuration) external;

    /// @notice Revokes a credential.
    /// @param registryId The id of the registry.
    /// @param revocationCommitment The revocation commitment of the credential.
    /// @param lowLeafIndex The physical index of the commitment's predecessor, found off chain.
    function revoke(uint256 registryId, uint256 revocationCommitment, uint256 lowLeafIndex) external;

    /// @notice Revokes several credentials in one call.
    /// @param registryId The id of the registry.
    /// @param revocationCommitments The commitments to revoke, in insertion order.
    /// @param lowLeafIndices Each commitment's predecessor index, in the tree state after the
    /// earlier commitments in the batch have been inserted.
    function revokeMany(uint256 registryId, uint256[] calldata revocationCommitments, uint256[] calldata lowLeafIndices)
        external;

    /// @notice Undoes a revocation.
    /// @dev A credential becomes valid again for every verifier, including those still accepting an
    /// older root. Revocation is normally permanent; reach for this deliberately.
    /// @param registryId The id of the registry.
    /// @param revocationCommitment The revoked commitment.
    /// @param predecessorIndex The physical index of the leaf whose `nextValue` is the commitment.
    function unrevoke(uint256 registryId, uint256 revocationCommitment, uint256 predecessorIndex) external;

    /// @notice Replaces a revoked commitment with another one, reusing its slot.
    /// @param registryId The id of the registry.
    /// @param oldRevocationCommitment The revoked commitment to replace.
    /// @param newRevocationCommitment The commitment to put in its place.
    /// @param oldPredecessorIndex The physical index of the old commitment's predecessor.
    /// @param newPredecessorIndex The physical index of the new commitment's predecessor, in the
    /// tree state after the old commitment has been unlinked.
    function updateRevocationCommitment(
        uint256 registryId,
        uint256 oldRevocationCommitment,
        uint256 newRevocationCommitment,
        uint256 oldPredecessorIndex,
        uint256 newPredecessorIndex
    ) external;

    /// @notice Whether a root may back a revocation proof right now.
    /// @dev This is the call a verifier makes. It accepts the registry's current root, and any root
    /// superseded strictly less than `rootDuration` seconds ago, so a `rootDuration` of zero accepts
    /// the current root only. It is the only on-chain read a privacy-preserving
    /// verification needs: the zero-knowledge proof itself is verified elsewhere, and it outputs the
    /// root that is checked here.
    /// @param registryId The id of the registry.
    /// @param revocationRoot The root the proof was built against.
    /// @return True if the root is currently accepted.
    function isValidRoot(uint256 registryId, uint256 revocationRoot) external view returns (bool);

    /// @notice The timestamp at which a root was superseded, or zero if it is not a past root.
    /// @dev Zero is also returned for the current root, which never expires while it is current.
    /// @param registryId The id of the registry.
    /// @param revocationRoot The root to look up.
    /// @return The timestamp at which the root stopped being current.
    function getRootSupersededAt(uint256 registryId, uint256 revocationRoot) external view returns (uint256);

    /// @notice The accepted-root window of a registry, in seconds.
    /// @param registryId The id of the registry.
    /// @return The window.
    function getRegistryRootDuration(uint256 registryId) external view returns (uint256);
}
