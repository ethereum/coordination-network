// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {
    InternalLeanIMTPlusSha256,
    LeanIMTPlusSha256Data
} from "@zk-kit/lean-imt-plus-sha256.sol/InternalLeanIMTPlusSha256.sol";
import { IRevocationRegistries } from "../interfaces/IRevocationRegistries.sol";
import { RevocationRegistries } from "../base/RevocationRegistries.sol";

/// @title Sha256RevocationRegistries
/// @notice {RevocationRegistries} over SHA-256 trees, from zk-kit's `lean-imt-plus-sha256.sol`. Its roots
/// can be proven by circuits over any field (BN254, secq256r1).
/// @dev Leaves are `sha256(value || nextValue || 1)` and nodes `sha256(left || right)` over 32-byte
/// words. Any non-zero `uint256` is accepted unreduced: if commitments are field elements, see the
/// README on canonical values. Off-chain counterpart: `sha256Scheme`.
abstract contract Sha256RevocationRegistries is RevocationRegistries {
    using InternalLeanIMTPlusSha256 for LeanIMTPlusSha256Data;

    mapping(uint256 registryId => LeanIMTPlusSha256Data tree) internal revocationTrees;

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

    /// @inheritdoc RevocationRegistries
    function _treeInsert(uint256 registryId, uint256 value, uint256 lowLeafIndex)
        internal
        override
        returns (uint256 index, uint256 root)
    {
        LeanIMTPlusSha256Data storage tree = revocationTrees[registryId];

        index = tree._insert(value, lowLeafIndex);
        root = tree._root();
    }

    /// @inheritdoc RevocationRegistries
    function _treeInsertMany(uint256 registryId, uint256[] calldata values, uint256[] calldata lowLeafIndices)
        internal
        override
        returns (uint256 root)
    {
        LeanIMTPlusSha256Data storage tree = revocationTrees[registryId];

        tree._insertMany(values, lowLeafIndices);
        root = tree._root();
    }

    /// @inheritdoc RevocationRegistries
    function _treeRemove(uint256 registryId, uint256 value, uint256 predecessorIndex)
        internal
        override
        returns (uint256 index, uint256 root)
    {
        LeanIMTPlusSha256Data storage tree = revocationTrees[registryId];

        index = tree._indexOf(value);
        tree._remove(value, predecessorIndex);
        root = tree._root();
    }

    /// @inheritdoc RevocationRegistries
    function _treeUpdate(
        uint256 registryId,
        uint256 oldValue,
        uint256 newValue,
        uint256 oldPredecessorIndex,
        uint256 newPredecessorIndex
    ) internal override returns (uint256 index, uint256 root) {
        LeanIMTPlusSha256Data storage tree = revocationTrees[registryId];

        index = tree._indexOf(oldValue);
        tree._update(oldValue, newValue, oldPredecessorIndex, newPredecessorIndex);
        root = tree._root();
    }
}
