// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { RevocationTestBase } from "../utils/RevocationTestBase.sol";

/// @dev Pins the contract's root against the roots the TypeScript package produces for the same
/// revocations in the same order.
///
/// This is the invariant the whole design rests on: a holder builds their proof off chain, against a
/// tree they rebuilt themselves, and the verifier checks the resulting root against this contract.
/// If the two implementations ever disagree on a hash, a padding rule or an insertion order, every
/// honest proof silently stops verifying. The same constants are asserted from the TypeScript side
/// in `packages/revocation-registry/tests/cross-language.test.ts`, so a drift in either implementation
/// fails a test in both.
contract CrossLanguageRootTest is RevocationTestBase {
    uint256 internal constant ROOT_OF_100_200_300 =
        6_282_515_766_925_950_962_036_120_222_350_516_575_776_330_851_858_331_345_995_966_968_883_294_491_461;

    uint256 internal constant ROOT_OF_300_100_200_50_900 =
        16_371_200_927_132_436_184_091_530_429_497_089_969_477_574_266_729_902_012_949_561_363_171_482_853_728;

    /// @dev 100, 200 and 300 revoked in that order, then 200 un-revoked.
    uint256 internal constant ROOT_OF_100_200_300_LESS_200 =
        16_715_334_225_205_977_020_523_340_649_771_286_490_583_486_141_052_800_548_644_784_042_059_257_683_463;

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

    /// @dev A tombstoned registry is the case where the two implementations could most easily drift:
    /// a removed slot keeps its Merkle position and its commitment becomes the canonical tombstone,
    /// so both sides must agree that the slot stays and what it hashes to. If either side compacted
    /// the slot away instead, the roots here would diverge while an insert-only test still passed.
    function test_rootMatchesTypeScriptAfterARemoval() public {
        revoke(registryId, 100);
        revoke(registryId, 200);
        revoke(registryId, 300);

        uint256 predecessor = predecessorIndex(registryId, 200);

        vm.prank(admin);
        revocation.unrevoke(registryId, 200, predecessor);

        assertEq(revocation.getRevocationRoot(registryId), ROOT_OF_100_200_300_LESS_200);
    }

    /// @dev The slot table a holder rebuilds a tombstoned registry from, pinned against the table
    /// `RevocationRegistry.leafSlots` produces for the same history.
    function test_leafSlotsMatchTypeScriptAfterARemoval() public {
        revoke(registryId, 100);
        revoke(registryId, 200);
        revoke(registryId, 300);

        uint256 predecessor = predecessorIndex(registryId, 200);

        vm.prank(admin);
        revocation.unrevoke(registryId, 200, predecessor);

        uint256[4] memory values = [uint256(0), 100, 0, 300];
        uint256[4] memory nextValues = [uint256(100), 300, 0, 0];

        // The tombstoned slot is still there: the leaf count did not shrink with the removal.
        assertEq(revocation.getRevocationTreeLeafCount(registryId), values.length);
        assertEq(revocation.getRevocationTreeSize(registryId), 2);

        for (uint256 i = 0; i < values.length; ++i) {
            (uint256 value, uint256 nextValue) = revocation.getLeaf(registryId, i);

            assertEq(value, values[i]);
            assertEq(nextValue, nextValues[i]);
        }
    }

    /// @dev The leaf slots are the rebuild path {getLeaf} promises: a holder reads them all and
    /// reconstructs the tree with `RevocationRegistry.fromLeaves`. That only works if both sides
    /// agree on which commitment lands in which slot and on what each slot points at, so the slot
    /// table below is the one the TypeScript package produces for the same revocations.
    function test_leafSlotsMatchTypeScript() public {
        revoke(registryId, 300);
        revoke(registryId, 100);
        revoke(registryId, 200);
        revoke(registryId, 50);
        revoke(registryId, 900);

        uint256[6] memory values = [uint256(0), 300, 100, 200, 50, 900];
        uint256[6] memory nextValues = [uint256(50), 900, 200, 300, 100, 0];

        assertEq(revocation.getRevocationTreeLeafCount(registryId), values.length);

        for (uint256 i = 0; i < values.length; ++i) {
            (uint256 value, uint256 nextValue) = revocation.getLeaf(registryId, i);

            assertEq(value, values[i]);
            assertEq(nextValue, nextValues[i]);
        }
    }
}
