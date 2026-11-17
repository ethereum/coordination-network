// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IIssuerRegistries
/// @notice Issuer registries: one LeanIMT of approved issuer commitments per registry, each with an admin.
interface IIssuerRegistries {
    error RegistryDoesNotExist();
    error CallerIsNotTheRegistryAdmin();
    error CallerIsNotThePendingRegistryAdmin();
    error ZeroAdmin();
    error NoIssuerCommitments();
    error IssuerCommitmentCannotBeZero();

    event RegistryCreated(uint256 indexed registryId);

    event RegistryAdminUpdated(uint256 indexed registryId, address indexed oldAdmin, address indexed newAdmin);

    event RegistryAdminPending(uint256 indexed registryId, address indexed oldAdmin, address indexed newAdmin);

    event IssuerAdded(uint256 indexed registryId, uint256 index, uint256 issuerCommitment, uint256 issuerRoot);

    event IssuersAdded(uint256 indexed registryId, uint256 startIndex, uint256[] issuerCommitments, uint256 issuerRoot);

    event IssuerRemoved(uint256 indexed registryId, uint256 index, uint256 issuerCommitment, uint256 issuerRoot);

    event IssuerCommitmentUpdated(
        uint256 indexed registryId,
        uint256 index,
        uint256 oldIssuerCommitment,
        uint256 newIssuerCommitment,
        uint256 issuerRoot
    );

    /// @notice The registry admin, or the zero address if the registry does not exist.
    function getRegistryAdmin(uint256 registryId) external view returns (address);

    function getPendingRegistryAdmin(uint256 registryId) external view returns (address);

    function isIssuer(uint256 registryId, uint256 issuerCommitment) external view returns (bool);

    /// @notice Reverts if the commitment is not in the registry.
    function indexOf(uint256 registryId, uint256 issuerCommitment) external view returns (uint256);

    /// @notice The leaf at an index, zero for a removed issuer. Reading every leaf rebuilds the tree off chain.
    function getLeaf(uint256 registryId, uint256 index) external view returns (uint256);

    /// @notice Zero before the first issuer is added or once a one-leaf registry is emptied. Removing every issuer
    /// of a larger registry leaves a non-zero root of zero leaves.
    function getIssuerRoot(uint256 registryId) external view returns (uint256);

    function getIssuerTreeDepth(uint256 registryId) external view returns (uint256);

    /// @notice The number of leaves, removed issuers included.
    function getIssuerTreeSize(uint256 registryId) external view returns (uint256);
}
