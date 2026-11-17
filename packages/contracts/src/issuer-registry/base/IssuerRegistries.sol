// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IIssuerRegistries } from "../interfaces/IIssuerRegistries.sol";

/// @title IssuerRegistries
/// @notice Hash-agnostic base: per-registry admins, writes, events and leaf values.
/// @dev Inherit a hash binding such as {PoseidonIssuerRegistries}, which owns the tree and implements the
/// hooks below. Leaf values are stored here because the LeanIMT keeps none.
abstract contract IssuerRegistries is IIssuerRegistries {
    /// @dev The zero address means the registry does not exist.
    mapping(uint256 registryId => address admin) internal registryAdmins;

    mapping(uint256 registryId => address pendingAdmin) internal pendingRegistryAdmins;

    /// @dev Every leaf in index order. Zero marks a removed issuer.
    mapping(uint256 registryId => uint256[] leaves) internal issuerLeaves;

    // Write hooks implemented by the hash binding. Each returns the new root.

    function _treeInsert(uint256 registryId, uint256 value) internal virtual returns (uint256 root);

    function _treeInsertMany(uint256 registryId, uint256[] calldata values) internal virtual returns (uint256 root);

    /// @dev A `newValue` of zero removes `oldValue`.
    function _treeUpdate(uint256 registryId, uint256 oldValue, uint256 newValue, uint256[] calldata siblingNodes)
        internal
        virtual
        returns (uint256 root);

    modifier onlyRegistryAdmin(uint256 registryId) {
        _onlyRegistryAdmin(registryId);
        _;
    }

    modifier onlyExistingRegistry(uint256 registryId) {
        _onlyExistingRegistry(registryId);
        _;
    }

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

    /// @dev Two-step: takes effect on {_acceptRegistryAdmin}.
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

    function _addIssuer(uint256 registryId, uint256 issuerCommitment)
        internal
        virtual
        onlyRegistryAdmin(registryId)
        returns (uint256 issuerRoot)
    {
        uint256[] storage leaves = issuerLeaves[registryId];
        uint256 index = leaves.length;

        issuerRoot = _treeInsert(registryId, issuerCommitment);

        leaves.push(issuerCommitment);

        emit IssuerAdded(registryId, index, issuerCommitment, issuerRoot);
    }

    function _addIssuers(uint256 registryId, uint256[] calldata issuerCommitments)
        internal
        virtual
        onlyRegistryAdmin(registryId)
        returns (uint256 issuerRoot)
    {
        // Not every binding's library rejects an empty batch.
        if (issuerCommitments.length == 0) revert NoIssuerCommitments();

        uint256[] storage leaves = issuerLeaves[registryId];
        uint256 startIndex = leaves.length;

        issuerRoot = _treeInsertMany(registryId, issuerCommitments);

        for (uint256 i = 0; i < issuerCommitments.length; ++i) {
            leaves.push(issuerCommitments[i]);
        }

        emit IssuersAdded(registryId, startIndex, issuerCommitments, issuerRoot);
    }

    function _removeIssuer(uint256 registryId, uint256 issuerCommitment, uint256[] calldata siblingNodes)
        internal
        virtual
        onlyRegistryAdmin(registryId)
        returns (uint256 issuerRoot)
    {
        uint256 index = indexOf(registryId, issuerCommitment);

        issuerRoot = _treeUpdate(registryId, issuerCommitment, 0, siblingNodes);

        issuerLeaves[registryId][index] = 0;

        emit IssuerRemoved(registryId, index, issuerCommitment, issuerRoot);
    }

    function _updateIssuerCommitment(
        uint256 registryId,
        uint256 oldIssuerCommitment,
        uint256 newIssuerCommitment,
        uint256[] calldata siblingNodes
    ) internal virtual onlyRegistryAdmin(registryId) returns (uint256 issuerRoot) {
        // The libraries treat a new value of zero as a removal.
        if (newIssuerCommitment == 0) revert IssuerCommitmentCannotBeZero();

        uint256 index = indexOf(registryId, oldIssuerCommitment);

        issuerRoot = _treeUpdate(registryId, oldIssuerCommitment, newIssuerCommitment, siblingNodes);

        issuerLeaves[registryId][index] = newIssuerCommitment;

        emit IssuerCommitmentUpdated(registryId, index, oldIssuerCommitment, newIssuerCommitment, issuerRoot);
    }

    /// @inheritdoc IIssuerRegistries
    function getRegistryAdmin(uint256 registryId) public view virtual override returns (address) {
        return registryAdmins[registryId];
    }

    /// @inheritdoc IIssuerRegistries
    function getPendingRegistryAdmin(uint256 registryId) public view virtual override returns (address) {
        return pendingRegistryAdmins[registryId];
    }

    /// @inheritdoc IIssuerRegistries
    function getLeaf(uint256 registryId, uint256 index) public view virtual override returns (uint256) {
        return issuerLeaves[registryId][index];
    }

    /// @inheritdoc IIssuerRegistries
    function indexOf(uint256 registryId, uint256 issuerCommitment) public view virtual override returns (uint256);

    /// @inheritdoc IIssuerRegistries
    function getIssuerRoot(uint256 registryId) public view virtual override returns (uint256);
}
