// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { InternalLeanIMTPlus, LeanIMTPlusData } from "@zk-kit/lean-imt-plus.sol/InternalLeanIMTPlus.sol";
import { IRevocationRegistries } from "../interfaces/IRevocationRegistries.sol";

/// @title RevocationRegistries
/// @notice Base contract that owns the revocation trees. Inherit it to build a revocation service.
/// @dev This is the reusable half of the package: it holds one LeanIMT+ per registry, gates every
/// write behind a per-registry admin, and exposes the read surface a holder needs to rebuild a tree
/// off chain. It deliberately knows nothing about root histories, expiry or proof systems, so a
/// consumer can layer its own policy on top. {Revocation} is the reference layer.
///
/// Every mutation takes the physical index of the affected leaf's predecessor as an argument. The
/// LeanIMT+ library validates that index in O(1) but does not search for it, which is what keeps a
/// write at O(depth) storage writes. Compute it off chain with the revocation-registry package:
/// `RevocationRegistry.lowLeafIndexOf` for a revocation, `RevocationRegistry.predecessorIndexOf` for an
/// un-revocation or an update. It must be computed against the same tree state the transaction will
/// execute in; if another write lands first the transaction reverts and the index must be
/// recomputed.
abstract contract RevocationRegistries is IRevocationRegistries {
    using InternalLeanIMTPlus for LeanIMTPlusData;

    /// @dev The LeanIMT+ backing each registry. Its leaves are the revoked commitments.
    mapping(uint256 registryId => LeanIMTPlusData tree) internal revocationTrees;

    /// @dev The admin of each registry. It can be an account or a contract, and is the only address
    /// allowed to revoke in that registry. The zero address means the registry does not exist.
    mapping(uint256 registryId => address admin) internal registryAdmins;

    /// @dev An admin that has been proposed for a registry and has not accepted yet.
    mapping(uint256 registryId => address pendingAdmin) internal pendingRegistryAdmins;

    /// @dev Restricts a call to the registry admin.
    /// @param registryId The id of the registry.
    modifier onlyRegistryAdmin(uint256 registryId) {
        _onlyRegistryAdmin(registryId);
        _;
    }

    /// @dev Requires the registry to exist.
    /// @param registryId The id of the registry.
    modifier onlyExistingRegistry(uint256 registryId) {
        _onlyExistingRegistry(registryId);
        _;
    }

    /// @dev The body of {onlyRegistryAdmin}, kept out of the modifier so the check is compiled
    /// once and jumped to rather than inlined at every guarded function.
    /// @param registryId The id of the registry.
    function _onlyRegistryAdmin(uint256 registryId) internal view {
        if (registryAdmins[registryId] != msg.sender) revert CallerIsNotTheRegistryAdmin();
    }

    /// @dev The body of {onlyExistingRegistry}, kept out of the modifier for the same reason.
    /// @param registryId The id of the registry.
    function _onlyExistingRegistry(uint256 registryId) internal view {
        if (registryAdmins[registryId] == address(0)) revert RegistryDoesNotExist();
    }

    /// @dev Creates a registry. The caller is responsible for allocating an unused `registryId`.
    /// @param registryId The id of the new registry.
    /// @param admin The address allowed to revoke in it.
    function _createRegistry(uint256 registryId, address admin) internal virtual {
        if (admin == address(0)) revert ZeroAdmin();

        registryAdmins[registryId] = admin;

        emit RegistryCreated(registryId);
        emit RegistryAdminUpdated(registryId, address(0), admin);
    }

    /// @dev Proposes a new registry admin. The transfer is two-step: it only takes effect once the
    /// proposed admin calls {_acceptRegistryAdmin}, so a typo cannot strand a registry.
    /// @param registryId The id of the registry.
    /// @param newAdmin The proposed admin.
    function _updateRegistryAdmin(uint256 registryId, address newAdmin) internal virtual onlyRegistryAdmin(registryId) {
        pendingRegistryAdmins[registryId] = newAdmin;

        emit RegistryAdminPending(registryId, msg.sender, newAdmin);
    }

    /// @dev Accepts a pending admin transfer. Callable only by the proposed admin.
    /// @param registryId The id of the registry.
    function _acceptRegistryAdmin(uint256 registryId) internal virtual {
        if (pendingRegistryAdmins[registryId] != msg.sender) revert CallerIsNotThePendingRegistryAdmin();

        address oldAdmin = registryAdmins[registryId];

        registryAdmins[registryId] = msg.sender;

        delete pendingRegistryAdmins[registryId];

        emit RegistryAdminUpdated(registryId, oldAdmin, msg.sender);
    }

    /// @dev Revokes a credential by inserting its commitment.
    /// @param registryId The id of the registry.
    /// @param revocationCommitment The revocation commitment of the credential.
    /// @param lowLeafIndex The physical index of the commitment's predecessor, found off chain and
    /// validated here. Ignored for the first revocation in a registry, which creates the sentinel.
    /// @return revocationRoot The new root of the registry.
    function _revoke(uint256 registryId, uint256 revocationCommitment, uint256 lowLeafIndex)
        internal
        virtual
        onlyRegistryAdmin(registryId)
        returns (uint256 revocationRoot)
    {
        uint256 index = revocationTrees[registryId]._insert(revocationCommitment, lowLeafIndex);
        revocationRoot = revocationTrees[registryId]._root();

        emit CredentialRevoked(registryId, index, revocationCommitment, revocationRoot);
    }

    /// @dev Revokes several credentials in one call. Cheaper than one {_revoke} per commitment,
    /// because every affected internal node is rehashed at most once.
    /// @param registryId The id of the registry.
    /// @param revocationCommitments The commitments to revoke, in insertion order.
    /// @param lowLeafIndices For each commitment, the physical index of its predecessor in the tree
    /// state after the earlier commitments in this batch have been inserted.
    /// @return revocationRoot The new root of the registry.
    function _revokeMany(
        uint256 registryId,
        uint256[] calldata revocationCommitments,
        uint256[] calldata lowLeafIndices
    ) internal virtual onlyRegistryAdmin(registryId) returns (uint256 revocationRoot) {
        revocationTrees[registryId]._insertMany(revocationCommitments, lowLeafIndices);
        revocationRoot = revocationTrees[registryId]._root();

        emit CredentialsRevoked(registryId, revocationCommitments, revocationRoot);
    }

    /// @dev Undoes a revocation, tombstoning the commitment's slot.
    /// @param registryId The id of the registry.
    /// @param revocationCommitment The revoked commitment.
    /// @param predecessorIndex The physical index of the leaf whose `nextValue` is the commitment.
    /// @return revocationRoot The new root of the registry.
    function _unrevoke(uint256 registryId, uint256 revocationCommitment, uint256 predecessorIndex)
        internal
        virtual
        onlyRegistryAdmin(registryId)
        returns (uint256 revocationRoot)
    {
        uint256 index = revocationTrees[registryId]._indexOf(revocationCommitment);

        revocationTrees[registryId]._remove(revocationCommitment, predecessorIndex);
        revocationRoot = revocationTrees[registryId]._root();

        emit CredentialUnrevoked(registryId, index, revocationCommitment, revocationRoot);
    }

    /// @dev Replaces a revoked commitment with another one, reusing its physical slot. Cheaper than
    /// an un-revocation followed by a revocation, which would tombstone a slot and append a new one.
    /// @param registryId The id of the registry.
    /// @param oldRevocationCommitment The revoked commitment to replace.
    /// @param newRevocationCommitment The commitment to put in its place.
    /// @param oldPredecessorIndex The physical index of the old commitment's predecessor.
    /// @param newPredecessorIndex The physical index of the new commitment's predecessor in the
    /// tree state after the old commitment has been unlinked.
    /// @return revocationRoot The new root of the registry.
    function _updateRevocationCommitment(
        uint256 registryId,
        uint256 oldRevocationCommitment,
        uint256 newRevocationCommitment,
        uint256 oldPredecessorIndex,
        uint256 newPredecessorIndex
    ) internal virtual onlyRegistryAdmin(registryId) returns (uint256 revocationRoot) {
        uint256 index = revocationTrees[registryId]._indexOf(oldRevocationCommitment);

        revocationTrees[registryId]._update(
            oldRevocationCommitment, newRevocationCommitment, oldPredecessorIndex, newPredecessorIndex
        );
        revocationRoot = revocationTrees[registryId]._root();

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
    function isRevoked(uint256 registryId, uint256 revocationCommitment) public view virtual override returns (bool) {
        return revocationTrees[registryId]._has(revocationCommitment);
    }

    /// @inheritdoc IRevocationRegistries
    function indexOf(uint256 registryId, uint256 revocationCommitment) public view virtual override returns (uint256) {
        return revocationTrees[registryId]._indexOf(revocationCommitment);
    }

    /// @inheritdoc IRevocationRegistries
    function getLeaf(uint256 registryId, uint256 index)
        public
        view
        virtual
        override
        returns (uint256 value, uint256 nextValue)
    {
        return (revocationTrees[registryId].leaves[index].value, revocationTrees[registryId].leaves[index].nextValue);
    }

    /// @inheritdoc IRevocationRegistries
    function getRevocationRoot(uint256 registryId) public view virtual override returns (uint256) {
        return revocationTrees[registryId]._root();
    }

    /// @inheritdoc IRevocationRegistries
    function getRevocationTreeDepth(uint256 registryId) public view virtual override returns (uint256) {
        return revocationTrees[registryId].depth;
    }

    /// @inheritdoc IRevocationRegistries
    function getRevocationTreeSize(uint256 registryId) public view virtual override returns (uint256) {
        return revocationTrees[registryId].size;
    }

    /// @inheritdoc IRevocationRegistries
    function getRevocationTreeLeafCount(uint256 registryId) public view virtual override returns (uint256) {
        return revocationTrees[registryId].leaves.length;
    }
}
