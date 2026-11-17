// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IssuerRegistryService } from "../../src/issuer-registry/base/IssuerRegistryService.sol";
import { Sha256IssuerRegistry } from "../../src/issuer-registry/sha256/Sha256IssuerRegistry.sol";
import { IssuerRegistryCrossLanguageRootTest } from "./IssuerRegistryCrossLanguageRoot.t.sol";

/// @dev The same histories against {Sha256IssuerRegistry} and `sha256Scheme`.
contract Sha256IssuerRegistryCrossLanguageRootTest is IssuerRegistryCrossLanguageRootTest {
    function deployIssuerRegistry() internal override returns (IssuerRegistryService) {
        return new Sha256IssuerRegistry();
    }

    function maxCommitment() internal pure override returns (uint256) {
        return type(uint256).max;
    }

    function hashNodes(uint256 left, uint256 right) internal pure override returns (uint256) {
        return uint256(sha256(abi.encodePacked(left, right)));
    }

    function rootOf100_200_300() internal pure override returns (uint256) {
        return 93805080911137514286305664785970201255654020885154000348023179261022723795396;
    }

    function rootOf300_100_200_50_900() internal pure override returns (uint256) {
        return 101303635641675734763162662120683549442686812240429308935070736332954422789383;
    }

    function rootOf100_200_300Less200() internal pure override returns (uint256) {
        return 13096474889912315376180021488918777854187494384453769718354334942754899487001;
    }

    function rootOf100_200_300With200UpdatedTo400() internal pure override returns (uint256) {
        return 101999388321653114002087667412150585743282582468049496342203867694175678013490;
    }

    function rootAtTheTopOfTheRange() internal pure override returns (uint256) {
        return 41375872462068963710440837698392059863240512031509844620661314680615792752993;
    }

    function rootAfterRemovalsAndAReAdd() internal pure override returns (uint256) {
        return 25268371512384373375842063580923886211184797836584604430972420561298243153889;
    }
}
