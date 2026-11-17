// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { RevocationRegistries } from "./RevocationRegistries.sol";
import { IRevocation } from "../interfaces/IRevocation.sol";

/// @title RevocationService
/// @notice Revocation policy: anyone can create a registry, and each registry keeps a bounded history
/// of accepted roots. Picks no hash; a deployable combines it with a hash binding, as {Revocation}
/// does.
abstract contract RevocationService is IRevocation, RevocationRegistries {
    /// @notice Covers a holder syncing and presenting, while bounding how long a revoked credential
    /// keeps verifying.
    uint256 public constant DEFAULT_ROOT_DURATION = 1 hours;

    mapping(uint256 registryId => Registry registry) internal registries;

    /// @inheritdoc IRevocation
    uint256 public override registryCounter;

    /// @inheritdoc IRevocation
    function createRegistry() external override returns (uint256 registryId) {
        return _createRegistryWithDuration(msg.sender, DEFAULT_ROOT_DURATION);
    }

    /// @inheritdoc IRevocation
    function createRegistry(address admin) external override returns (uint256 registryId) {
        return _createRegistryWithDuration(admin, DEFAULT_ROOT_DURATION);
    }

    /// @inheritdoc IRevocation
    function createRegistry(address admin, uint256 rootDuration) external override returns (uint256 registryId) {
        return _createRegistryWithDuration(admin, rootDuration);
    }

    /// @inheritdoc IRevocation
    function updateRegistryAdmin(uint256 registryId, address newAdmin) external override {
        _updateRegistryAdmin(registryId, newAdmin);
    }

    /// @inheritdoc IRevocation
    function acceptRegistryAdmin(uint256 registryId) external override {
        _acceptRegistryAdmin(registryId);
    }

    /// @inheritdoc IRevocation
    function updateRegistryRootDuration(uint256 registryId, uint256 newRootDuration)
        external
        override
        onlyRegistryAdmin(registryId)
    {
        uint256 oldRootDuration = registries[registryId].rootDuration;

        registries[registryId].rootDuration = newRootDuration;

        emit RegistryRootDurationUpdated(registryId, oldRootDuration, newRootDuration);
    }

    /// @inheritdoc IRevocation
    function revoke(uint256 registryId, uint256 revocationCommitment, uint256 lowLeafIndex) external override {
        uint256 oldRoot = getRevocationRoot(registryId);

        _revoke(registryId, revocationCommitment, lowLeafIndex);

        _supersedeRoot(registryId, oldRoot);
    }

    /// @inheritdoc IRevocation
    function revokeMany(uint256 registryId, uint256[] calldata revocationCommitments, uint256[] calldata lowLeafIndices)
        external
        override
    {
        uint256 oldRoot = getRevocationRoot(registryId);

        _revokeMany(registryId, revocationCommitments, lowLeafIndices);

        _supersedeRoot(registryId, oldRoot);
    }

    /// @inheritdoc IRevocation
    function unrevoke(uint256 registryId, uint256 revocationCommitment, uint256 predecessorIndex) external override {
        uint256 oldRoot = getRevocationRoot(registryId);

        _unrevoke(registryId, revocationCommitment, predecessorIndex);

        _supersedeRoot(registryId, oldRoot);
    }

    /// @inheritdoc IRevocation
    function updateRevocationCommitment(
        uint256 registryId,
        uint256 oldRevocationCommitment,
        uint256 newRevocationCommitment,
        uint256 oldPredecessorIndex,
        uint256 newPredecessorIndex
    ) external override {
        uint256 oldRoot = getRevocationRoot(registryId);

        _updateRevocationCommitment(
            registryId, oldRevocationCommitment, newRevocationCommitment, oldPredecessorIndex, newPredecessorIndex
        );

        _supersedeRoot(registryId, oldRoot);
    }

    /// @inheritdoc IRevocation
    function isValidRoot(uint256 registryId, uint256 revocationRoot)
        external
        view
        override
        onlyExistingRegistry(registryId)
        returns (bool)
    {
        if (revocationRoot == getRevocationRoot(registryId)) return true;

        uint256 supersededAt = registries[registryId].rootSupersededAt[revocationRoot];

        if (supersededAt == 0) return false;

        // Strict, so a `rootDuration` of zero gives no grace at all. Validator timestamp drift is
        // seconds against a window of minutes or hours. Subtracting cannot underflow, since
        // `supersededAt` is never in the future, and unlike `supersededAt + rootDuration` cannot overflow.
        // forge-lint: disable-next-line(block-timestamp)
        return block.timestamp - supersededAt < registries[registryId].rootDuration;
    }

    /// @inheritdoc IRevocation
    function getRootSupersededAt(uint256 registryId, uint256 revocationRoot) external view override returns (uint256) {
        return registries[registryId].rootSupersededAt[revocationRoot];
    }

    /// @inheritdoc IRevocation
    function getRegistryRootDuration(uint256 registryId) external view override returns (uint256) {
        return registries[registryId].rootDuration;
    }

    function _createRegistryWithDuration(address admin, uint256 rootDuration) private returns (uint256 registryId) {
        registryId = registryCounter++;

        _createRegistry(registryId, admin);

        registries[registryId].rootDuration = rootDuration;
    }

    /// @dev Starts the expiry clock of the root a write just replaced. The current root never
    /// expires, so the newest root that still verifies a revoked credential stops being accepted
    /// `rootDuration` after that credential's revocation.
    function _supersedeRoot(uint256 registryId, uint256 oldRoot) private {
        registries[registryId].rootSupersededAt[oldRoot] = block.timestamp;
    }
}
