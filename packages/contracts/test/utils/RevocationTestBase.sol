// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Revocation } from "../../src/revocation/Revocation.sol";
import { CanonicalDependencies } from "./CanonicalDependencies.sol";

/// @dev Shared fixture. Also stands in for the off-chain half of the protocol: the contract validates
/// a predecessor index but never searches for one, so tests have to supply it the same way the
/// revocation-registry package does. The scans below are deliberately naive and are only acceptable
/// because tests keep registries tiny; the package answers the same questions against its own ordered
/// index instead of walking every slot.
abstract contract RevocationTestBase is CanonicalDependencies {
    Revocation internal revocation;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    uint256 internal registryId;

    function setUp() public virtual {
        revocation = new Revocation();

        vm.prank(admin);
        registryId = revocation.createRegistry();
    }

    /// @dev The physical index of the leaf that precedes `value` in sorted order.
    function lowLeafIndex(uint256 id, uint256 value) internal view returns (uint256) {
        uint256 leafCount = revocation.getRevocationTreeLeafCount(id);

        for (uint256 i = 0; i < leafCount; ++i) {
            (uint256 leafValue, uint256 nextValue) = revocation.getLeaf(id, i);

            // Tombstones are `{0, 0}` and can never be a low leaf; the sentinel is `{0, > 0}`.
            if (leafValue == 0 && nextValue == 0 && i != 0) continue;

            if (leafValue < value && (nextValue > value || nextValue == 0)) return i;
        }

        revert("no low leaf found");
    }

    /// @dev The physical index of the leaf whose `nextValue` is `value`.
    function predecessorIndex(uint256 id, uint256 value) internal view returns (uint256) {
        uint256 leafCount = revocation.getRevocationTreeLeafCount(id);

        for (uint256 i = 0; i < leafCount; ++i) {
            (, uint256 nextValue) = revocation.getLeaf(id, i);

            if (nextValue == value) return i;
        }

        revert("no predecessor found");
    }

    /// @dev Revokes as the registry admin, resolving the low leaf index first.
    function revoke(uint256 id, uint256 commitment) internal {
        uint256 index = revocation.getRevocationTreeLeafCount(id) == 0 ? 0 : lowLeafIndex(id, commitment);

        vm.prank(revocation.getRegistryAdmin(id));
        revocation.revoke(id, commitment, index);
    }
}
