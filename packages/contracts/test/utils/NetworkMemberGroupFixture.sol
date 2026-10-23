// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";

/// @dev Merkle helpers for the approved-member group, shared by the test bases of the contracts that
/// gate on it. Removing a member takes the siblings proving its leaf's place, and only the test knows
/// the group's leaves.
abstract contract NetworkMemberGroupFixture {
    /// @dev The sibling nodes proving the leaf at `index` sits in the member group, in the compacted
    /// form the LeanIMT expects: a level where the node has no sibling contributes nothing, because
    /// the node is carried up unchanged.
    function _memberProofSiblings(uint256[] memory leaves, uint256 index)
        internal
        pure
        returns (uint256[] memory siblings)
    {
        uint256 depth = 0;
        while ((1 << depth) < leaves.length) {
            ++depth;
        }

        uint256[] memory buffer = new uint256[](depth);
        uint256[] memory level = leaves;
        uint256 count = 0;

        for (uint256 d = 0; d < depth; ++d) {
            uint256 siblingIndex = index ^ 1;
            if (siblingIndex < level.length) {
                buffer[count++] = level[siblingIndex];
            }

            level = _hashLevel(level);
            index >>= 1;
        }

        siblings = new uint256[](count);
        for (uint256 i = 0; i < count; ++i) {
            siblings[i] = buffer[i];
        }
    }

    /// @dev One LeanIMT level: pairs are Poseidon-hashed, a lone right-most node is carried up.
    function _hashLevel(uint256[] memory level) private pure returns (uint256[] memory next) {
        next = new uint256[]((level.length + 1) / 2);

        for (uint256 i = 0; i < level.length; i += 2) {
            next[i / 2] = i + 1 < level.length ? PoseidonT3.hash([level[i], level[i + 1]]) : level[i];
        }
    }
}
