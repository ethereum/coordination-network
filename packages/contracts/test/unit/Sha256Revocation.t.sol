// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { TAG_LEAF } from "@zk-kit/lean-imt-plus-sha256.sol/Constants.sol";
import { RevocationService } from "../../src/revocation/base/RevocationService.sol";
import { Sha256Revocation } from "../../src/revocation/sha256/Sha256Revocation.sol";
import { RevocationFuzzTest } from "../fuzz/Revocation.t.sol";
import { RevocationTest } from "./Revocation.t.sol";
import { RevocationRegistriesTest } from "./RevocationRegistries.t.sol";

/// @dev The hash-agnostic revocation suites, run against {Sha256Revocation}.
contract Sha256RevocationTest is RevocationTest {
    function deployRevocation() internal override returns (RevocationService) {
        return new Sha256Revocation();
    }

    function maxCommitment() internal pure override returns (uint256) {
        return type(uint256).max;
    }
}

contract Sha256RevocationRegistriesTest is RevocationRegistriesTest {
    function deployRevocation() internal override returns (RevocationService) {
        return new Sha256Revocation();
    }

    function maxCommitment() internal pure override returns (uint256) {
        return type(uint256).max;
    }

    /// @dev Two leaves, so the root is the node hash of their two SHA-256 leaf commitments.
    function test_leavesCommitToTheDomainSeparatedLeafHash() public override {
        revoke(registryId, A);

        (uint256 value, uint256 nextValue) = revocation.getLeaf(registryId, 0);
        (uint256 leafValue, uint256 leafNextValue) = revocation.getLeaf(registryId, 1);

        bytes32 left = sha256(abi.encodePacked(value, nextValue, TAG_LEAF));
        bytes32 right = sha256(abi.encodePacked(leafValue, leafNextValue, TAG_LEAF));

        assertEq(revocation.getRevocationRoot(registryId), uint256(sha256(abi.encodePacked(left, right))));
    }

    /// @dev Values above the BN254 field are valid SHA-256 commitments.
    function test_revoke_acceptsValuesAboveTheBn254Field() public {
        uint256 max = type(uint256).max;

        revoke(registryId, max);
        revoke(registryId, 1);
        revoke(registryId, max - 7);

        assertTrue(revocation.isRevoked(registryId, max));
        assertTrue(revocation.isRevoked(registryId, max - 7));
    }
}

contract Sha256RevocationFuzzTest is RevocationFuzzTest {
    function deployRevocation() internal override returns (RevocationService) {
        return new Sha256Revocation();
    }

    function maxCommitment() internal pure override returns (uint256) {
        return type(uint256).max;
    }
}
