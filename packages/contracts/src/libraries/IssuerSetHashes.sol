// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { PoseidonT4 } from "poseidon-solidity/PoseidonT4.sol";

/// @title IssuerSetHashes
/// @notice The approved-issuer-set leaf and internal-node formulas.
/// @dev The single Solidity home of these formulas, so a change to the Poseidon instantiation is
/// one edit here plus regenerated vectors. Their counterparts are the `hash_3` leaf and `hash_2`
/// internal node in `packages/circuits/src/issuer.nr`, and `issuerLeaf` in
/// `packages/issuer-set/src/hashes.ts`; all three must agree or every honest proof stops
/// verifying.
library IssuerSetHashes {
    /// @notice Domain separator for a leaf commitment, matching `packages/credential`'s
    /// `ISSUER_LEAF_DOMAIN` and the circuit's `LEAF_DOMAIN`.
    uint256 internal constant ISSUER_LEAF_DOMAIN =
        185404551131306766954100762329350135288498146007932686448214248919067924295;

    /// @notice Commits a Baby Jubjub public key to the field element the tree stores as a leaf.
    /// @param publicKeyX The public key's x coordinate.
    /// @param publicKeyY The public key's y coordinate.
    /// @return The leaf value.
    function issuerKeyLeaf(uint256 publicKeyX, uint256 publicKeyY) internal pure returns (uint256) {
        return PoseidonT4.hash([ISSUER_LEAF_DOMAIN, publicKeyX, publicKeyY]);
    }

    /// @notice Combines two child nodes into their parent.
    /// @param left The left child.
    /// @param right The right child.
    /// @return The parent value.
    function internalNode(uint256 left, uint256 right) internal pure returns (uint256) {
        return PoseidonT3.hash([left, right]);
    }
}
