// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IssuerRegistries } from "./IssuerRegistries.sol";
import { IIssuerRegistry } from "../interfaces/IIssuerRegistry.sol";

/// @title IssuerRegistryService
/// @notice Policy: anyone can create a registry, and each keeps a bounded history of accepted roots.
/// Picks no hash; a deployable combines it with a hash binding.
abstract contract IssuerRegistryService is IIssuerRegistry, IssuerRegistries {
    uint256 public constant DEFAULT_ROOT_DURATION = 1 hours;

    mapping(uint256 registryId => Registry registry) internal registries;

    /// @inheritdoc IIssuerRegistry
    uint256 public override registryCounter;

    /// @inheritdoc IIssuerRegistry
    function createRegistry() external override returns (uint256 registryId) {
        return _createRegistryWithDuration(msg.sender, DEFAULT_ROOT_DURATION);
    }

    /// @inheritdoc IIssuerRegistry
    function createRegistry(address admin) external override returns (uint256 registryId) {
        return _createRegistryWithDuration(admin, DEFAULT_ROOT_DURATION);
    }

    /// @inheritdoc IIssuerRegistry
    function createRegistry(address admin, uint256 rootDuration) external override returns (uint256 registryId) {
        return _createRegistryWithDuration(admin, rootDuration);
    }

    /// @inheritdoc IIssuerRegistry
    function updateRegistryAdmin(uint256 registryId, address newAdmin) external override {
        _updateRegistryAdmin(registryId, newAdmin);
    }

    /// @inheritdoc IIssuerRegistry
    function acceptRegistryAdmin(uint256 registryId) external override {
        _acceptRegistryAdmin(registryId);
    }

    /// @inheritdoc IIssuerRegistry
    function updateRegistryRootDuration(uint256 registryId, uint256 newRootDuration)
        external
        override
        onlyRegistryAdmin(registryId)
    {
        uint256 oldRootDuration = registries[registryId].rootDuration;

        registries[registryId].rootDuration = newRootDuration;

        emit RegistryRootDurationUpdated(registryId, oldRootDuration, newRootDuration);
    }

    /// @inheritdoc IIssuerRegistry
    function expireRegistryRoots(uint256 registryId) external override onlyRegistryAdmin(registryId) {
        registries[registryId].rootsExpiredAt = block.timestamp;
        registries[registryId].rootAtExpiry = getIssuerRoot(registryId);

        emit RegistryRootsExpired(registryId);
    }

    /// @inheritdoc IIssuerRegistry
    function addIssuer(uint256 registryId, uint256 issuerCommitment) external override {
        uint256 oldRoot = getIssuerRoot(registryId);

        uint256 newRoot = _addIssuer(registryId, issuerCommitment);

        _replaceRoot(registryId, oldRoot, newRoot);
    }

    /// @inheritdoc IIssuerRegistry
    function addIssuers(uint256 registryId, uint256[] calldata issuerCommitments) external override {
        uint256 oldRoot = getIssuerRoot(registryId);

        uint256 newRoot = _addIssuers(registryId, issuerCommitments);

        _replaceRoot(registryId, oldRoot, newRoot);
    }

    /// @inheritdoc IIssuerRegistry
    function removeIssuer(uint256 registryId, uint256 issuerCommitment, uint256[] calldata siblingNodes)
        external
        override
    {
        uint256 oldRoot = getIssuerRoot(registryId);

        uint256 newRoot = _removeIssuer(registryId, issuerCommitment, siblingNodes);

        _replaceRoot(registryId, oldRoot, newRoot);
    }

    /// @inheritdoc IIssuerRegistry
    function updateIssuerCommitment(
        uint256 registryId,
        uint256 oldIssuerCommitment,
        uint256 newIssuerCommitment,
        uint256[] calldata siblingNodes
    ) external override {
        uint256 oldRoot = getIssuerRoot(registryId);

        uint256 newRoot = _updateIssuerCommitment(registryId, oldIssuerCommitment, newIssuerCommitment, siblingNodes);

        _replaceRoot(registryId, oldRoot, newRoot);
    }

    /// @inheritdoc IIssuerRegistry
    function isValidRoot(uint256 registryId, uint256 issuerRoot)
        external
        view
        override
        onlyExistingRegistry(registryId)
        returns (bool)
    {
        if (issuerRoot == 0) return false;

        if (issuerRoot == getIssuerRoot(registryId)) return true;

        Registry storage registry = registries[registryId];

        uint256 supersededAt = registry.rootSupersededAt[issuerRoot];

        if (supersededAt == 0 || supersededAt < registry.rootsExpiredAt) return false;

        // Superseded in the block of the expiry: only the root current at the expiry was superseded after it.
        if (supersededAt == registry.rootsExpiredAt && issuerRoot != registry.rootAtExpiry) return false;

        // Strict, so a zero `rootDuration` gives no grace. Subtracting avoids overflow.
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp - supersededAt < registry.rootDuration;
    }

    /// @inheritdoc IIssuerRegistry
    function getRootSupersededAt(uint256 registryId, uint256 issuerRoot) external view override returns (uint256) {
        return registries[registryId].rootSupersededAt[issuerRoot];
    }

    /// @inheritdoc IIssuerRegistry
    function getRegistryRootDuration(uint256 registryId) external view override returns (uint256) {
        return registries[registryId].rootDuration;
    }

    /// @inheritdoc IIssuerRegistry
    function getRegistryRootsExpiredAt(uint256 registryId) external view override returns (uint256) {
        return registries[registryId].rootsExpiredAt;
    }

    function _createRegistryWithDuration(address admin, uint256 rootDuration) private returns (uint256 registryId) {
        registryId = registryCounter++;

        _createRegistry(registryId, admin);

        registries[registryId].rootDuration = rootDuration;
    }

    /// @dev Starts the expiry clock of the replaced root, skipping the never-valid empty root, and clears
    /// the new root's stamp in case an update brought back an earlier root.
    function _replaceRoot(uint256 registryId, uint256 oldRoot, uint256 newRoot) private {
        mapping(uint256 => uint256) storage rootSupersededAt = registries[registryId].rootSupersededAt;

        if (oldRoot != 0) rootSupersededAt[oldRoot] = block.timestamp;

        delete rootSupersededAt[newRoot];
    }
}
