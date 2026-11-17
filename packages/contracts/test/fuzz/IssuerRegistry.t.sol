// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IssuerRegistryTestBase } from "../utils/IssuerRegistryTestBase.sol";

contract IssuerRegistryFuzzTest is IssuerRegistryTestBase {
    /// @dev Whatever is added and removed, every leaf reads back, every live issuer is findable, and
    /// the root is the one a holder rebuilds from {getLeaf}.
    function testFuzz_theRootIsRebuildableFromTheLeaves(uint256[8] calldata rawCommitments, uint8 removals) public {
        uint256[] memory added = new uint256[](rawCommitments.length);
        uint256 count;

        for (uint256 i = 0; i < rawCommitments.length; ++i) {
            uint256 commitment = bound(rawCommitments[i], 1, maxCommitment());

            if (issuerRegistry.isIssuer(registryId, commitment)) continue;

            add(registryId, commitment);
            added[count++] = commitment;
        }

        for (uint256 i = 0; i < count; ++i) {
            if ((removals >> i) & 1 == 0) continue;

            remove(registryId, added[i]);
        }

        assertEq(issuerRegistry.getIssuerTreeSize(registryId), count);
        assertEq(issuerRegistry.getIssuerRoot(registryId), rebuiltRoot(registryId));

        for (uint256 i = 0; i < count; ++i) {
            bool removed = (removals >> i) & 1 == 1;

            assertEq(issuerRegistry.isIssuer(registryId, added[i]), !removed);
            assertEq(issuerRegistry.getLeaf(registryId, i), removed ? 0 : added[i]);
        }
    }

    /// @dev A superseded root is accepted for exactly the configured window, never longer.
    function testFuzz_supersededRootExpiresAtTheEndOfTheWindow(uint256 rootDuration, uint256 elapsed) public {
        rootDuration = bound(rootDuration, 0, 365 days);
        elapsed = bound(elapsed, 0, 2 * 365 days);

        uint256 id = issuerRegistry.createRegistry(admin, rootDuration);

        add(id, 100);
        uint256 oldRoot = issuerRegistry.getIssuerRoot(id);

        add(id, 200);
        uint256 supersededAt = block.timestamp;

        vm.warp(supersededAt + elapsed);

        assertEq(issuerRegistry.isValidRoot(id, oldRoot), elapsed < rootDuration);
        assertTrue(issuerRegistry.isValidRoot(id, issuerRegistry.getIssuerRoot(id)));
    }
}
