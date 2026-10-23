// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { SNARK_SCALAR_FIELD } from "@zk-kit/lean-imt-plus.sol/Constants.sol";
import { RevocationTestBase } from "../utils/RevocationTestBase.sol";

contract RevocationFuzzTest is RevocationTestBase {
    /// @dev Whatever order commitments arrive in, the sorted linked list stays consistent and every
    /// revoked commitment is reported as revoked.
    function testFuzz_revokedCommitmentsStaySortedAndFindable(uint256[8] calldata rawCommitments) public {
        uint256[] memory revoked = new uint256[](rawCommitments.length);
        uint256 count;

        for (uint256 i = 0; i < rawCommitments.length; ++i) {
            uint256 commitment = bound(rawCommitments[i], 1, SNARK_SCALAR_FIELD - 1);

            if (revocation.isRevoked(registryId, commitment)) continue;

            revoke(registryId, commitment);
            revoked[count++] = commitment;
        }

        assertEq(revocation.getRevocationTreeSize(registryId), count);

        for (uint256 i = 0; i < count; ++i) {
            assertTrue(revocation.isRevoked(registryId, revoked[i]));
        }

        // Walk the implicit linked list from the sentinel: it must visit every revoked commitment
        // exactly once, in strictly ascending order, and terminate.
        (, uint256 next) = revocation.getLeaf(registryId, 0);
        uint256 previous;
        uint256 visited;

        while (next != 0) {
            assertGt(next, previous);
            assertTrue(revocation.isRevoked(registryId, next));

            previous = next;
            ++visited;

            (, next) = revocation.getLeaf(registryId, revocation.indexOf(registryId, next));
        }

        assertEq(visited, count);
    }

    /// @dev A superseded root is accepted for exactly the configured window, never longer. A window
    /// of zero accepts nothing superseded, not even within the same block.
    function testFuzz_supersededRootExpiresAtTheEndOfTheWindow(uint256 rootDuration, uint256 elapsed) public {
        rootDuration = bound(rootDuration, 0, 365 days);
        elapsed = bound(elapsed, 0, 2 * 365 days);

        uint256 id = revocation.createRegistry(admin, rootDuration);

        revoke(id, 100);
        uint256 oldRoot = revocation.getRevocationRoot(id);

        revoke(id, 200);
        uint256 supersededAt = block.timestamp;

        vm.warp(supersededAt + elapsed);

        assertEq(revocation.isValidRoot(id, oldRoot), elapsed < rootDuration);
        assertTrue(revocation.isValidRoot(id, revocation.getRevocationRoot(id)));
    }
}
