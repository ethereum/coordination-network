// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { InternalLeanIMTPlus, LeanIMTPlusData } from "@zk-kit/lean-imt-plus.sol/InternalLeanIMTPlus.sol";
import { IRevocationRegistries } from "../interfaces/IRevocationRegistries.sol";
import { RevocationRegistries } from "../base/RevocationRegistries.sol";

/// @title PoseidonRevocationRegistries
/// @notice {RevocationRegistries} over Poseidon (BN254) trees, from zk-kit's `lean-imt-plus.sol`.
/// @dev The hash binding: the only contract that imports the tree library. Values must be below the
/// BN254 scalar field order, which the library enforces. Off-chain counterpart: `poseidonScheme`.
abstract contract PoseidonRevocationRegistries is RevocationRegistries {
    using InternalLeanIMTPlus for LeanIMTPlusData;

    mapping(uint256 registryId => LeanIMTPlusData tree) internal revocationTrees;

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
        LeanIMTPlusData storage tree = revocationTrees[registryId];

        index = tree._insert(value, lowLeafIndex);
        root = tree._root();
    }

    /// @inheritdoc RevocationRegistries
    function _treeInsertMany(uint256 registryId, uint256[] calldata values, uint256[] calldata lowLeafIndices)
        internal
        override
        returns (uint256 root)
    {
        LeanIMTPlusData storage tree = revocationTrees[registryId];

        tree._insertMany(values, lowLeafIndices);
        root = tree._root();
    }

    /// @inheritdoc RevocationRegistries
    function _treeRemove(uint256 registryId, uint256 value, uint256 predecessorIndex)
        internal
        override
        returns (uint256 index, uint256 root)
    {
        LeanIMTPlusData storage tree = revocationTrees[registryId];

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
        LeanIMTPlusData storage tree = revocationTrees[registryId];

        index = tree._indexOf(oldValue);
        tree._update(oldValue, newValue, oldPredecessorIndex, newPredecessorIndex);
        root = tree._root();
    }
}
