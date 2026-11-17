// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { RevocationService } from "../../src/revocation/base/RevocationService.sol";
import { Sha256Revocation } from "../../src/revocation/sha256/Sha256Revocation.sol";
import { RevocationTestBase } from "../utils/RevocationTestBase.sol";

/// @dev Pins {Sha256Revocation}'s roots against the roots `sha256Scheme` in the revocation-registry
/// package produces for the same history. The same constants are asserted from the TypeScript side
/// in `packages/revocation-registry/tests/cross-language.test.ts`.
contract Sha256CrossLanguageRootTest is RevocationTestBase {
    uint256 internal constant ROOT_OF_100_200_300 =
        29_449_428_493_174_361_538_792_687_231_728_088_594_453_315_694_514_874_094_346_425_442_234_014_065_663;

    uint256 internal constant ROOT_OF_300_100_200_50_900 =
        30_126_325_348_536_030_815_389_760_905_862_706_784_635_330_282_365_433_073_746_407_152_010_779_633_218;

    /// @dev 100, 200 and 300 revoked in that order, then 200 un-revoked.
    uint256 internal constant ROOT_OF_100_200_300_LESS_200 =
        106_899_670_355_996_405_606_312_012_622_101_961_449_732_694_913_392_084_839_680_045_540_256_857_266_450;

    /// @dev 100 and 200 revoked, then 200 replaced by 300 in place.
    uint256 internal constant ROOT_OF_100_200_UPDATED_TO_300 =
        95_987_111_907_579_532_077_455_028_845_619_190_925_351_527_047_512_101_488_463_451_847_083_800_101_661;

    /// @dev `max`, 1 and `max - 7` revoked in that order, with `max = 2^256 - 1`.
    uint256 internal constant ROOT_AT_THE_TOP_OF_THE_RANGE =
        29_329_670_266_340_303_611_996_914_523_237_903_405_984_053_418_112_979_014_052_703_112_824_158_411_795;

    function deployRevocation() internal override returns (RevocationService) {
        return new Sha256Revocation();
    }

    function test_rootMatchesTypeScriptForAnAscendingInsertionOrder() public {
        revoke(registryId, 100);
        revoke(registryId, 200);
        revoke(registryId, 300);

        assertEq(revocation.getRevocationRoot(registryId), ROOT_OF_100_200_300);
    }

    function test_rootMatchesTypeScriptForAnUnsortedInsertionOrder() public {
        revoke(registryId, 300);
        revoke(registryId, 100);
        revoke(registryId, 200);
        revoke(registryId, 50);
        revoke(registryId, 900);

        assertEq(revocation.getRevocationRoot(registryId), ROOT_OF_300_100_200_50_900);
    }

    function test_rootMatchesTypeScriptAfterARemoval() public {
        revoke(registryId, 100);
        revoke(registryId, 200);
        revoke(registryId, 300);

        uint256 predecessor = predecessorIndex(registryId, 200);

        vm.prank(admin);
        revocation.unrevoke(registryId, 200, predecessor);

        assertEq(revocation.getRevocationRoot(registryId), ROOT_OF_100_200_300_LESS_200);
    }

    function test_rootMatchesTypeScriptAfterAnInPlaceUpdate() public {
        revoke(registryId, 100);
        revoke(registryId, 200);

        uint256 oldPredecessor = predecessorIndex(registryId, 200);
        uint256 newPredecessor = revocation.indexOf(registryId, 100);

        vm.prank(admin);
        revocation.updateRevocationCommitment(registryId, 200, 300, oldPredecessor, newPredecessor);

        assertEq(revocation.getRevocationRoot(registryId), ROOT_OF_100_200_UPDATED_TO_300);
    }

    function test_rootMatchesTypeScriptAtTheTopOfTheRange() public {
        uint256 max = type(uint256).max;

        revoke(registryId, max);
        revoke(registryId, 1);
        revoke(registryId, max - 7);

        assertEq(revocation.getRevocationRoot(registryId), ROOT_AT_THE_TOP_OF_THE_RANGE);
    }
}
