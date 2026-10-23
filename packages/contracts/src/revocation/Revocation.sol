// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { RevocationRegistries } from "./base/RevocationRegistries.sol";
import { IRevocation } from "./interfaces/IRevocation.sol";

/// @title Revocation
/// @notice Deployable revocation service. Anyone can create a registry and revoke credentials in it.
/// @dev One deployment serves many issuers: each gets its own registry, its own LeanIMT+ and its own
/// root history, and can only write to its own. Contracts that want revocation as part of a larger
/// protocol can inherit {RevocationRegistries} directly instead of using this one.
///
/// The flow this contract is one third of:
///
///  1. an issuer revokes a credential here, publishing its revocation commitment;
///  2. a holder rebuilds the registry's tree off chain and proves, in zero knowledge, that their
///     commitment is *not* in it, which outputs the root they proved against;
///  3. a verifier checks that zero-knowledge proof and calls {isValidRoot} with the root it output.
///
/// Only step 1 and the {isValidRoot} half of step 3 happen on chain. The commitment never appears in
/// a verification, which is what keeps a presentation unlinkable.
contract Revocation is IRevocation, RevocationRegistries {
    /// @notice The accepted-root window a registry gets unless it asks for another one.
    /// @dev One hour comfortably covers a holder syncing the tree and presenting a credential, while
    /// bounding how long a credential revoked a moment ago can still be presented as valid.
    uint256 public constant DEFAULT_ROOT_DURATION = 1 hours;

    /// @dev The policy and root history of each registry.
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

        // Strict, so that a `rootDuration` of zero means exactly no grace at all rather than a
        // one-timestamp window. A superseded root is accepted for `rootDuration` seconds, counted
        // from the moment it stopped being current.
        //
        // Both sides come from the same clock, and the window is a policy measured in minutes or
        // hours, so the seconds of drift a validator can introduce cannot meaningfully lengthen or
        // shorten it. The worst case is a proof accepted or rejected a few seconds either side of
        // its deadline, which is what the window exists to tolerate in the first place.
        //
        // `supersededAt` is never in the future, so the subtraction cannot underflow, and unlike
        // `supersededAt + rootDuration` it cannot overflow for any `rootDuration`.
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

    /// @dev Allocates the next registry id and records its root window.
    /// @param admin The address allowed to revoke in the registry.
    /// @param rootDuration How long a superseded root stays acceptable, in seconds.
    /// @return registryId The id of the new registry.
    function _createRegistryWithDuration(address admin, uint256 rootDuration) private returns (uint256 registryId) {
        registryId = registryCounter++;

        _createRegistry(registryId, admin);

        registries[registryId].rootDuration = rootDuration;
    }

    /// @dev Starts the expiry clock of the root a mutation just replaced.
    ///
    /// A root's window runs from the moment it stops being current, which is the moment recorded
    /// here. Until then it is the current root and never expires, however long it stays current.
    /// Every root therefore gets the same full window, covering exactly the interval in which a
    /// proof built against it can still be in flight.
    ///
    /// This is also what bounds the exposure: the newest root that still verifies an already
    /// revoked credential is the one that credential's own revocation replaced, so it stops being
    /// accepted `rootDuration` seconds after that revocation.
    ///
    /// @param registryId The id of the registry.
    /// @param oldRoot The root the mutation replaced.
    function _supersedeRoot(uint256 registryId, uint256 oldRoot) private {
        registries[registryId].rootSupersededAt[oldRoot] = block.timestamp;
    }
}
