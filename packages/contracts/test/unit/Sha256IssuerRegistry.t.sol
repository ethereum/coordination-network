// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { SNARK_SCALAR_FIELD } from "@zk-kit/lean-imt.sol/Constants.sol";
import { IssuerRegistryService } from "../../src/issuer-registry/base/IssuerRegistryService.sol";
import { Sha256IssuerRegistry } from "../../src/issuer-registry/sha256/Sha256IssuerRegistry.sol";
import { IssuerRegistryFuzzTest } from "../fuzz/IssuerRegistry.t.sol";
import { IssuerRegistriesTest } from "./IssuerRegistries.t.sol";
import { IssuerRegistryTest } from "./IssuerRegistry.t.sol";

/// @dev The hash-agnostic issuer registry suites, run against {Sha256IssuerRegistry}.
contract Sha256IssuerRegistryTest is IssuerRegistryTest {
    function deployIssuerRegistry() internal override returns (IssuerRegistryService) {
        return new Sha256IssuerRegistry();
    }

    function maxCommitment() internal pure override returns (uint256) {
        return type(uint256).max;
    }

    function hashNodes(uint256 left, uint256 right) internal pure override returns (uint256) {
        return uint256(sha256(abi.encodePacked(left, right)));
    }
}

contract Sha256IssuerRegistriesTest is IssuerRegistriesTest {
    function deployIssuerRegistry() internal override returns (IssuerRegistryService) {
        return new Sha256IssuerRegistry();
    }

    function maxCommitment() internal pure override returns (uint256) {
        return type(uint256).max;
    }

    function hashNodes(uint256 left, uint256 right) internal pure override returns (uint256) {
        return uint256(sha256(abi.encodePacked(left, right)));
    }

    /// @dev No `uint256` is above the SHA-256 range, so values above the BN254 field are accepted
    /// instead.
    function test_addIssuer_rejectsAValueAboveTheRange() public override {
        add(registryId, SNARK_SCALAR_FIELD);
        add(registryId, type(uint256).max - 7);

        assertTrue(issuerRegistry.isIssuer(registryId, SNARK_SCALAR_FIELD));
        assertTrue(issuerRegistry.isIssuer(registryId, type(uint256).max - 7));
    }

    function test_theRootHashesTheLeavesWithTheSchemeNodeHash() public override {
        add(registryId, A);
        add(registryId, B);
        add(registryId, C);

        bytes32 left = sha256(abi.encodePacked(A, B));

        assertEq(issuerRegistry.getIssuerRoot(registryId), uint256(sha256(abi.encodePacked(left, C))));
    }
}

contract Sha256IssuerRegistryFuzzTest is IssuerRegistryFuzzTest {
    function deployIssuerRegistry() internal override returns (IssuerRegistryService) {
        return new Sha256IssuerRegistry();
    }

    function maxCommitment() internal pure override returns (uint256) {
        return type(uint256).max;
    }

    function hashNodes(uint256 left, uint256 right) internal pure override returns (uint256) {
        return uint256(sha256(abi.encodePacked(left, right)));
    }
}
