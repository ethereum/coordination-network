// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IRevocationRegistries } from "../interfaces/IRevocationRegistries.sol";

/// @title RevocationRegistries
/// @notice Hash-agnostic base for revocation registries: per-registry admins, the write flow and its
/// events. Policy such as root histories belongs to a layer on top, like {RevocationService}.
/// @dev Inherit a hash binding such as {PoseidonRevocationRegistries}, not this contract: the binding
/// owns the tree storage and implements the tree reads and the four write hooks below.
///
/// Every write takes the predecessor's physical index, which the LeanIMT+ library validates in O(1)
/// instead of searching. Compute it off chain against the state the transaction will execute in
/// (`lowLeafIndexOf` / `predecessorIndexOf` in the revocation-registry package); if another write
/// lands first, the transaction reverts and the index must be recomputed.
abstract contract RevocationRegistries is IRevocationRegistries {
    /// @dev The zero address means the registry does not exist.
    mapping(uint256 registryId => address admin) internal registryAdmins;

    mapping(uint256 registryId => address pendingAdmin) internal pendingRegistryAdmins;

    // Write hooks, implemented by the hash binding. Each returns the new root, and the leaf index an
    // event needs, so the base never reads the tree back after a write.

    /// @return index The physical index of the new leaf.
    function _treeInsert(uint256 registryId, uint256 value, uint256 lowLeafIndex)
        internal
        virtual
        returns (uint256 index, uint256 root);

    /// @dev `lowLeafIndices` are against the state after the earlier values are inserted.
    function _treeInsertMany(uint256 registryId, uint256[] calldata values, uint256[] calldata lowLeafIndices)
        internal
        virtual
        returns (uint256 root);

    /// @return index The physical index of the slot the value occupied, now a tombstone.
    function _treeRemove(uint256 registryId, uint256 value, uint256 predecessorIndex)
        internal
        virtual
        returns (uint256 index, uint256 root);

    /// @return index The physical index of the slot, which the new value reuses.
    function _treeUpdate(
        uint256 registryId,
        uint256 oldValue,
        uint256 newValue,
        uint256 oldPredecessorIndex,
        uint256 newPredecessorIndex
    ) internal virtual returns (uint256 index, uint256 root);

    modifier onlyRegistryAdmin(uint256 registryId) {
        _onlyRegistryAdmin(registryId);
        _;
    }

    modifier onlyExistingRegistry(uint256 registryId) {
        _onlyExistingRegistry(registryId);
        _;
    }

    // Modifier bodies live in functions so they are compiled once instead of inlined at every use.
    function _onlyRegistryAdmin(uint256 registryId) internal view {
        if (registryAdmins[registryId] != msg.sender) revert CallerIsNotTheRegistryAdmin();
    }

    function _onlyExistingRegistry(uint256 registryId) internal view {
        if (registryAdmins[registryId] == address(0)) revert RegistryDoesNotExist();
    }

    /// @dev The caller must allocate an unused `registryId`.
    function _createRegistry(uint256 registryId, address admin) internal virtual {
        if (admin == address(0)) revert ZeroAdmin();

        registryAdmins[registryId] = admin;

        emit RegistryCreated(registryId);
        emit RegistryAdminUpdated(registryId, address(0), admin);
    }

    /// @dev Two-step: takes effect on {_acceptRegistryAdmin}, so a typo cannot strand a registry.
    function _updateRegistryAdmin(uint256 registryId, address newAdmin) internal virtual onlyRegistryAdmin(registryId) {
        pendingRegistryAdmins[registryId] = newAdmin;

        emit RegistryAdminPending(registryId, msg.sender, newAdmin);
    }

    function _acceptRegistryAdmin(uint256 registryId) internal virtual {
        if (pendingRegistryAdmins[registryId] != msg.sender) revert CallerIsNotThePendingRegistryAdmin();

        address oldAdmin = registryAdmins[registryId];

        registryAdmins[registryId] = msg.sender;

        delete pendingRegistryAdmins[registryId];

        emit RegistryAdminUpdated(registryId, oldAdmin, msg.sender);
    }

    /// @param lowLeafIndex Ignored for the registry's first revocation, which creates the sentinel.
    function _revoke(uint256 registryId, uint256 revocationCommitment, uint256 lowLeafIndex)
        internal
        virtual
        onlyRegistryAdmin(registryId)
        returns (uint256 revocationRoot)
    {
        uint256 index;
        (index, revocationRoot) = _treeInsert(registryId, revocationCommitment, lowLeafIndex);

        emit CredentialRevoked(registryId, index, revocationCommitment, revocationRoot);
    }

    function _revokeMany(
        uint256 registryId,
        uint256[] calldata revocationCommitments,
        uint256[] calldata lowLeafIndices
    ) internal virtual onlyRegistryAdmin(registryId) returns (uint256 revocationRoot) {
        revocationRoot = _treeInsertMany(registryId, revocationCommitments, lowLeafIndices);

        emit CredentialsRevoked(registryId, revocationCommitments, revocationRoot);
    }

    /// @dev Tombstones the commitment's slot.
    function _unrevoke(uint256 registryId, uint256 revocationCommitment, uint256 predecessorIndex)
        internal
        virtual
        onlyRegistryAdmin(registryId)
        returns (uint256 revocationRoot)
    {
        uint256 index;
        (index, revocationRoot) = _treeRemove(registryId, revocationCommitment, predecessorIndex);

        emit CredentialUnrevoked(registryId, index, revocationCommitment, revocationRoot);
    }

    /// @dev Reuses the commitment's slot instead of tombstoning it and appending a new one.
    function _updateRevocationCommitment(
        uint256 registryId,
        uint256 oldRevocationCommitment,
        uint256 newRevocationCommitment,
        uint256 oldPredecessorIndex,
        uint256 newPredecessorIndex
    ) internal virtual onlyRegistryAdmin(registryId) returns (uint256 revocationRoot) {
        uint256 index;
        (index, revocationRoot) = _treeUpdate(
            registryId, oldRevocationCommitment, newRevocationCommitment, oldPredecessorIndex, newPredecessorIndex
        );

        emit RevocationCommitmentUpdated(
            registryId, index, oldRevocationCommitment, newRevocationCommitment, revocationRoot
        );
    }

    /// @inheritdoc IRevocationRegistries
    function getRegistryAdmin(uint256 registryId) public view virtual override returns (address) {
        return registryAdmins[registryId];
    }

    /// @inheritdoc IRevocationRegistries
    function getPendingRegistryAdmin(uint256 registryId) public view virtual override returns (address) {
        return pendingRegistryAdmins[registryId];
    }

    /// @inheritdoc IRevocationRegistries
    function isRevoked(uint256 registryId, uint256 revocationCommitment) public view virtual override returns (bool);

    /// @inheritdoc IRevocationRegistries
    function indexOf(uint256 registryId, uint256 revocationCommitment) public view virtual override returns (uint256);

    /// @inheritdoc IRevocationRegistries
    function getRevocationRoot(uint256 registryId) public view virtual override returns (uint256);
}
