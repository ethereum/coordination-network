// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IssuerRegistryTestBase } from "../utils/IssuerRegistryTestBase.sol";

/// @dev Pins {IssuerRegistry}'s roots against the roots the issuer-registry package produces for the
/// same history. A holder builds their proof against a tree they rebuilt off chain, and the verifier
/// checks the resulting root against this contract, so a drift in either implementation silently
/// breaks every honest proof. The same constants are asserted from the TypeScript side in
/// `packages/issuer-registry/tests/cross-language.test.ts`.
contract IssuerRegistryCrossLanguageRootTest is IssuerRegistryTestBase {
    function rootOf100_200_300() internal pure virtual returns (uint256) {
        return 3925045059169335782833407477321845405342042180089864692501953598893457304808;
    }

    function rootOf300_100_200_50_900() internal pure virtual returns (uint256) {
        return 19859590655771910700590144031884476876350423465228809141242344822195565097368;
    }

    /// @dev 100, 200 and 300 added in that order, then 200 removed.
    function rootOf100_200_300Less200() internal pure virtual returns (uint256) {
        return 5669516470378802616293624245697922982622946828131598763076682078386975990445;
    }

    /// @dev 100, 200 and 300 added, then 200 replaced by 400 in place.
    function rootOf100_200_300With200UpdatedTo400() internal pure virtual returns (uint256) {
        return 10961825507292970642995133391392839183635325099968459091901054002589842274376;
    }

    /// @dev `max`, 1 and `max - 7` added in that order, with `max` the largest accepted commitment.
    function rootAtTheTopOfTheRange() internal pure virtual returns (uint256) {
        return 11864977421243360970430964084020268000962783534283303225545691252049900955005;
    }

    /// @dev 100 to 500 added, 100 and 500 removed, then 100 added again.
    function rootAfterRemovalsAndAReAdd() internal pure virtual returns (uint256) {
        return 10121527940021409969512850627702146629668767621816708257596873663802416109299;
    }

    function test_rootMatchesTypeScriptForAnAscendingInsertionOrder() public {
        add(registryId, 100);
        add(registryId, 200);
        add(registryId, 300);

        assertEq(issuerRegistry.getIssuerRoot(registryId), rootOf100_200_300());
    }

    function test_rootMatchesTypeScriptForAnUnsortedBatch() public {
        uint256[] memory commitments = new uint256[](5);
        commitments[0] = 300;
        commitments[1] = 100;
        commitments[2] = 200;
        commitments[3] = 50;
        commitments[4] = 900;

        vm.prank(admin);
        issuerRegistry.addIssuers(registryId, commitments);

        assertEq(issuerRegistry.getIssuerRoot(registryId), rootOf300_100_200_50_900());
    }

    function test_rootMatchesTypeScriptAfterARemoval() public {
        add(registryId, 100);
        add(registryId, 200);
        add(registryId, 300);

        remove(registryId, 200);

        assertEq(issuerRegistry.getIssuerRoot(registryId), rootOf100_200_300Less200());
    }

    function test_rootMatchesTypeScriptAfterAnInPlaceUpdate() public {
        add(registryId, 100);
        add(registryId, 200);
        add(registryId, 300);

        update(registryId, 200, 400);

        assertEq(issuerRegistry.getIssuerRoot(registryId), rootOf100_200_300With200UpdatedTo400());
    }

    function test_rootMatchesTypeScriptAtTheTopOfTheRange() public {
        uint256 max = maxCommitment();

        add(registryId, max);
        add(registryId, 1);
        add(registryId, max - 7);

        assertEq(issuerRegistry.getIssuerRoot(registryId), rootAtTheTopOfTheRange());
    }

    /// @dev The leaves a holder rebuilds from, pinned against `IssuerRegistry.leaves` for the same
    /// history: removed slots stay as zeros, and a re-added issuer takes a new slot.
    function test_rootAndLeavesMatchTypeScriptAfterRemovalsAndAReAdd() public {
        for (uint256 commitment = 100; commitment <= 500; commitment += 100) {
            add(registryId, commitment);
        }

        remove(registryId, 100);
        remove(registryId, 500);
        add(registryId, 100);

        uint256[6] memory leaves = [uint256(0), 200, 300, 400, 0, 100];

        assertEq(issuerRegistry.getIssuerTreeSize(registryId), leaves.length);

        for (uint256 i = 0; i < leaves.length; ++i) {
            assertEq(issuerRegistry.getLeaf(registryId, i), leaves[i]);
        }

        assertEq(issuerRegistry.getIssuerRoot(registryId), rootAfterRemovalsAndAReAdd());
    }
}
