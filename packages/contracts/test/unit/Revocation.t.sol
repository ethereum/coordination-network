// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IRevocation } from "../../src/revocation/interfaces/IRevocation.sol";
import { IRevocationRegistries } from "../../src/revocation/interfaces/IRevocationRegistries.sol";
import { RevocationTestBase } from "../utils/RevocationTestBase.sol";

/// @dev Covers the policy half of the service: registry allocation and the accepted-root window.
contract RevocationTest is RevocationTestBase {
    uint256 internal constant A = 100;
    uint256 internal constant B = 200;

    function test_createRegistry_allocatesIncrementalIds() public {
        assertEq(revocation.registryCounter(), 1);

        uint256 second = revocation.createRegistry(admin);

        assertEq(second, registryId + 1);
        assertEq(revocation.registryCounter(), 2);
    }

    function test_createRegistry_appliesTheDefaultRootWindow() public view {
        assertEq(revocation.getRegistryRootDuration(registryId), revocation.DEFAULT_ROOT_DURATION());
    }

    function test_createRegistry_acceptsACustomRootWindow() public {
        uint256 id = revocation.createRegistry(admin, 2 days);

        assertEq(revocation.getRegistryRootDuration(id), 2 days);
    }

    function test_createRegistry_acceptsAZeroRootWindow() public {
        uint256 id = revocation.createRegistry(admin, 0);

        assertEq(revocation.getRegistryRootDuration(id), 0);
    }

    function test_registriesAreIsolatedFromEachOther() public {
        uint256 other = revocation.createRegistry(stranger);

        revoke(registryId, A);

        assertTrue(revocation.isRevoked(registryId, A));
        assertFalse(revocation.isRevoked(other, A));
        assertEq(revocation.getRevocationRoot(other), 0);

        vm.prank(stranger);
        vm.expectRevert(IRevocationRegistries.CallerIsNotTheRegistryAdmin.selector);
        revocation.revoke(registryId, B, 0);
    }

    function test_updateRegistryRootDuration_changesTheWindow() public {
        vm.expectEmit(true, false, false, true);
        emit IRevocation.RegistryRootDurationUpdated(registryId, revocation.DEFAULT_ROOT_DURATION(), 30 minutes);

        vm.prank(admin);
        revocation.updateRegistryRootDuration(registryId, 30 minutes);

        assertEq(revocation.getRegistryRootDuration(registryId), 30 minutes);
    }

    function test_updateRegistryRootDuration_acceptsZero() public {
        vm.prank(admin);
        revocation.updateRegistryRootDuration(registryId, 0);

        assertEq(revocation.getRegistryRootDuration(registryId), 0);
    }

    function test_updateRegistryRootDuration_isOnlyForTheRegistryAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IRevocationRegistries.CallerIsNotTheRegistryAdmin.selector);
        revocation.updateRegistryRootDuration(registryId, 1 days);
    }

    function test_aZeroRootWindowAcceptsOnlyTheCurrentRoot() public {
        uint256 id = revocation.createRegistry(admin, 0);

        revoke(id, A);
        assertEq(revocation.getRootSupersededAt(id, 0), block.timestamp);
        assertFalse(revocation.isValidRoot(id, 0));
        uint256 oldRoot = revocation.getRevocationRoot(id);

        revoke(id, B);

        // Superseded in this very block, and already rejected: a zero window means no grace at all,
        // not a one-timestamp window.
        assertFalse(revocation.isValidRoot(id, oldRoot));
        assertTrue(revocation.isValidRoot(id, revocation.getRevocationRoot(id)));
    }

    function test_isValidRoot_acceptsTheCurrentRoot() public {
        revoke(registryId, A);

        assertTrue(revocation.isValidRoot(registryId, revocation.getRevocationRoot(registryId)));
    }

    function test_isValidRoot_rejectsARootThatWasNeverPublished() public view {
        assertFalse(revocation.isValidRoot(registryId, 42));
    }

    function test_isValidRoot_revertsForARegistryThatDoesNotExist() public {
        vm.expectRevert(IRevocationRegistries.RegistryDoesNotExist.selector);
        revocation.isValidRoot(registryId + 1, 42);
    }

    function test_isValidRoot_acceptsASupersededRootInsideTheWindow() public {
        revoke(registryId, A);
        uint256 oldRoot = revocation.getRevocationRoot(registryId);

        revoke(registryId, B);

        assertTrue(revocation.getRevocationRoot(registryId) != oldRoot);
        assertTrue(revocation.isValidRoot(registryId, oldRoot));

        vm.warp(block.timestamp + revocation.DEFAULT_ROOT_DURATION() - 1);
        assertTrue(revocation.isValidRoot(registryId, oldRoot));
    }

    function test_isValidRoot_rejectsASupersededRootAtTheEndOfTheWindow() public {
        revoke(registryId, A);
        uint256 oldRoot = revocation.getRevocationRoot(registryId);

        revoke(registryId, B);

        vm.warp(block.timestamp + revocation.DEFAULT_ROOT_DURATION());

        assertFalse(revocation.isValidRoot(registryId, oldRoot));
    }

    function test_isValidRoot_acceptsASupersededRootWithTheMaximumWindow() public {
        // The largest window means the admin never wants superseded roots to expire, so the check
        // has to keep accepting them at that value rather than overflow.
        vm.prank(admin);
        revocation.updateRegistryRootDuration(registryId, type(uint256).max);

        revoke(registryId, A);
        uint256 oldRoot = revocation.getRevocationRoot(registryId);

        revoke(registryId, B);

        vm.warp(block.timestamp + 365 days);

        assertTrue(revocation.isValidRoot(registryId, oldRoot));
    }

    function test_isValidRoot_measuresTheWindowFromSupersessionNotCreation() public {
        revoke(registryId, A);
        uint256 oldRoot = revocation.getRevocationRoot(registryId);

        // The root stays current far longer than the window. It must still get its full grace
        // period once a later revocation replaces it, or a holder who synced while it was current
        // would be rejected the moment they present.
        vm.warp(block.timestamp + 30 days);
        revoke(registryId, B);

        assertEq(revocation.getRootSupersededAt(registryId, oldRoot), block.timestamp);
        assertTrue(revocation.isValidRoot(registryId, oldRoot));
    }

    function test_getRootSupersededAt_isZeroWhileARootIsCurrent() public {
        revoke(registryId, A);

        assertEq(revocation.getRootSupersededAt(registryId, revocation.getRevocationRoot(registryId)), 0);
    }

    function test_theEmptyRootGetsAFullGraceWindowAfterTheFirstRevocation() public {
        assertTrue(revocation.isValidRoot(registryId, 0));
        vm.warp(block.timestamp + 30 days);
        revoke(registryId, A);
        uint256 supersededAt = block.timestamp;

        assertEq(revocation.getRootSupersededAt(registryId, 0), supersededAt);
        assertTrue(revocation.isValidRoot(registryId, 0));

        vm.warp(supersededAt + revocation.DEFAULT_ROOT_DURATION() / 2);
        revoke(registryId, B);
        assertEq(revocation.getRootSupersededAt(registryId, 0), supersededAt);

        vm.warp(supersededAt + revocation.DEFAULT_ROOT_DURATION() - 1);
        assertTrue(revocation.isValidRoot(registryId, 0));

        vm.warp(supersededAt + revocation.DEFAULT_ROOT_DURATION());
        assertFalse(revocation.isValidRoot(registryId, 0));
    }

    function test_everyMutationSupersedesThePreviousRoot() public {
        revoke(registryId, A);
        revoke(registryId, B);

        uint256 rootBeforeUnrevoke = revocation.getRevocationRoot(registryId);
        uint256 bPredecessor = predecessorIndex(registryId, B);

        vm.prank(admin);
        revocation.unrevoke(registryId, B, bPredecessor);

        assertEq(revocation.getRootSupersededAt(registryId, rootBeforeUnrevoke), block.timestamp);

        uint256 rootBeforeUpdate = revocation.getRevocationRoot(registryId);
        uint256 aPredecessor = predecessorIndex(registryId, A);

        vm.prank(admin);
        revocation.updateRevocationCommitment(registryId, A, B, aPredecessor, 0);

        assertEq(revocation.getRootSupersededAt(registryId, rootBeforeUpdate), block.timestamp);
    }

    function test_revokeMany_supersedesThePreviousRoot() public {
        revoke(registryId, A);
        uint256 rootBeforeRevokeMany = revocation.getRevocationRoot(registryId);
        uint256 revokeManyTime = 1 days;
        uint256[] memory commitments = new uint256[](1);
        commitments[0] = B;
        uint256[] memory lowLeafIndices = new uint256[](1);
        lowLeafIndices[0] = lowLeafIndex(registryId, B);
        vm.warp(revokeManyTime);

        vm.prank(admin);
        revocation.revokeMany(registryId, commitments, lowLeafIndices);

        uint256 rootAfterRevokeMany = revocation.getRevocationRoot(registryId);
        uint256 rootSupersededAt = revocation.getRootSupersededAt(registryId, rootBeforeRevokeMany);
        assertNotEq(rootAfterRevokeMany, rootBeforeRevokeMany);
        assertEq(rootSupersededAt, revokeManyTime);
    }
}
