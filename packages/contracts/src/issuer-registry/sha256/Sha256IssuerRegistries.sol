// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { InternalLeanIMTSha256, LeanIMTSha256Data } from "@zk-kit/lean-imt-sha256.sol/InternalLeanIMTSha256.sol";
import { IIssuerRegistries } from "../interfaces/IIssuerRegistries.sol";
import { IssuerRegistries } from "../base/IssuerRegistries.sol";

/// @title Sha256IssuerRegistries
/// @notice {IssuerRegistries} over SHA-256 trees, from zk-kit's `lean-imt-sha256.sol`.
/// @dev Any non-zero `uint256` is accepted unreduced. Off-chain counterpart: `sha256Scheme`.
abstract contract Sha256IssuerRegistries is IssuerRegistries {
    using InternalLeanIMTSha256 for LeanIMTSha256Data;

    mapping(uint256 registryId => LeanIMTSha256Data tree) internal issuerTrees;

    /// @inheritdoc IIssuerRegistries
    function isIssuer(uint256 registryId, uint256 issuerCommitment) public view virtual override returns (bool) {
        return issuerTrees[registryId]._has(issuerCommitment);
    }

    /// @inheritdoc IIssuerRegistries
    function indexOf(uint256 registryId, uint256 issuerCommitment) public view virtual override returns (uint256) {
        return issuerTrees[registryId]._indexOf(issuerCommitment);
    }

    /// @inheritdoc IIssuerRegistries
    function getIssuerRoot(uint256 registryId) public view virtual override returns (uint256) {
        return issuerTrees[registryId]._root();
    }

    /// @inheritdoc IIssuerRegistries
    function getIssuerTreeDepth(uint256 registryId) public view virtual override returns (uint256) {
        return issuerTrees[registryId].depth;
    }

    /// @inheritdoc IIssuerRegistries
    function getIssuerTreeSize(uint256 registryId) public view virtual override returns (uint256) {
        return issuerTrees[registryId].size;
    }

    /// @inheritdoc IssuerRegistries
    function _treeInsert(uint256 registryId, uint256 value) internal override returns (uint256 root) {
        return issuerTrees[registryId]._insert(value);
    }

    /// @inheritdoc IssuerRegistries
    function _treeInsertMany(uint256 registryId, uint256[] calldata values) internal override returns (uint256 root) {
        return issuerTrees[registryId]._insertMany(values);
    }

    /// @inheritdoc IssuerRegistries
    function _treeUpdate(uint256 registryId, uint256 oldValue, uint256 newValue, uint256[] calldata siblingNodes)
        internal
        override
        returns (uint256 root)
    {
        return issuerTrees[registryId]._update(oldValue, newValue, siblingNodes);
    }
}
