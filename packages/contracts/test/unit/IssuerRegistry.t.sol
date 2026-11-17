// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IIssuerRegistry } from "../../src/issuer-registry/interfaces/IIssuerRegistry.sol";
import { IIssuerRegistries } from "../../src/issuer-registry/interfaces/IIssuerRegistries.sol";
import { IssuerRegistryTestBase } from "../utils/IssuerRegistryTestBase.sol";

/// @dev Covers the policy half of the service: registry allocation and the accepted-root window.
contract IssuerRegistryTest is IssuerRegistryTestBase {
    uint256 internal constant A = 100;
    uint256 internal constant B = 200;
    uint256 internal constant C = 300;

    function test_createRegistry_allocatesIncrementalIds() public {
        assertEq(issuerRegistry.registryCounter(), 1);

        uint256 second = issuerRegistry.createRegistry(admin);

        assertEq(second, registryId + 1);
        assertEq(issuerRegistry.registryCounter(), 2);
        assertEq(issuerRegistry.getRegistryAdmin(second), admin);
    }

    function test_createRegistry_appliesTheDefaultRootWindow() public view {
        assertEq(issuerRegistry.getRegistryRootDuration(registryId), issuerRegistry.DEFAULT_ROOT_DURATION());
    }

    function test_createRegistry_acceptsACustomRootWindow() public {
        uint256 id = issuerRegistry.createRegistry(admin, 2 days);

        assertEq(issuerRegistry.getRegistryRootDuration(id), 2 days);
    }

    function test_registriesAreIsolatedFromEachOther() public {
        uint256 other = issuerRegistry.createRegistry(stranger);

        add(registryId, A);

        assertTrue(issuerRegistry.isIssuer(registryId, A));
        assertFalse(issuerRegistry.isIssuer(other, A));
        assertEq(issuerRegistry.getIssuerRoot(other), 0);

        vm.prank(stranger);
        vm.expectRevert(IIssuerRegistries.CallerIsNotTheRegistryAdmin.selector);
        issuerRegistry.addIssuer(registryId, B);
    }

    function test_updateRegistryRootDuration_changesTheWindow() public {
        vm.expectEmit(true, false, false, true);
        emit IIssuerRegistry.RegistryRootDurationUpdated(registryId, issuerRegistry.DEFAULT_ROOT_DURATION(), 30 minutes);

        vm.prank(admin);
        issuerRegistry.updateRegistryRootDuration(registryId, 30 minutes);

        assertEq(issuerRegistry.getRegistryRootDuration(registryId), 30 minutes);
    }

    function test_updateRegistryRootDuration_isOnlyForTheRegistryAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IIssuerRegistries.CallerIsNotTheRegistryAdmin.selector);
        issuerRegistry.updateRegistryRootDuration(registryId, 1 days);
    }

    function test_aZeroRootWindowAcceptsOnlyTheCurrentRoot() public {
        uint256 id = issuerRegistry.createRegistry(admin, 0);

        add(id, A);
        uint256 oldRoot = issuerRegistry.getIssuerRoot(id);

        add(id, B);

        // Superseded in this very block, and already rejected: a zero window means no grace at all.
        assertFalse(issuerRegistry.isValidRoot(id, oldRoot));
        assertTrue(issuerRegistry.isValidRoot(id, issuerRegistry.getIssuerRoot(id)));
    }

    function test_isValidRoot_acceptsTheCurrentRoot() public {
        add(registryId, A);

        assertTrue(issuerRegistry.isValidRoot(registryId, issuerRegistry.getIssuerRoot(registryId)));
    }

    function test_isValidRoot_rejectsTheEmptyRoot() public view {
        assertEq(issuerRegistry.getIssuerRoot(registryId), 0);
        assertFalse(issuerRegistry.isValidRoot(registryId, 0));
    }

    function test_isValidRoot_rejectsTheZeroRootOfAnEmptiedRegistry() public {
        add(registryId, A);
        remove(registryId, A);

        assertEq(issuerRegistry.getIssuerRoot(registryId), 0);
        assertFalse(issuerRegistry.isValidRoot(registryId, 0));
    }

    function test_isValidRoot_rejectsARootThatWasNeverPublished() public view {
        assertFalse(issuerRegistry.isValidRoot(registryId, 42));
    }

    function test_isValidRoot_revertsForARegistryThatDoesNotExist() public {
        vm.expectRevert(IIssuerRegistries.RegistryDoesNotExist.selector);
        issuerRegistry.isValidRoot(registryId + 1, 42);
    }

    function test_isValidRoot_acceptsASupersededRootInsideTheWindow() public {
        add(registryId, A);
        uint256 oldRoot = issuerRegistry.getIssuerRoot(registryId);

        add(registryId, B);

        assertTrue(issuerRegistry.isValidRoot(registryId, oldRoot));

        vm.warp(block.timestamp + issuerRegistry.DEFAULT_ROOT_DURATION() - 1);
        assertTrue(issuerRegistry.isValidRoot(registryId, oldRoot));
    }

    function test_isValidRoot_rejectsASupersededRootAtTheEndOfTheWindow() public {
        add(registryId, A);
        uint256 oldRoot = issuerRegistry.getIssuerRoot(registryId);

        add(registryId, B);

        vm.warp(block.timestamp + issuerRegistry.DEFAULT_ROOT_DURATION());

        assertFalse(issuerRegistry.isValidRoot(registryId, oldRoot));
    }

    function test_isValidRoot_acceptsASupersededRootWithTheMaximumWindow() public {
        vm.prank(admin);
        issuerRegistry.updateRegistryRootDuration(registryId, type(uint256).max);

        add(registryId, A);
        uint256 oldRoot = issuerRegistry.getIssuerRoot(registryId);

        add(registryId, B);

        vm.warp(block.timestamp + 365 days);

        assertTrue(issuerRegistry.isValidRoot(registryId, oldRoot));
    }

    function test_isValidRoot_measuresTheWindowFromSupersessionNotCreation() public {
        add(registryId, A);
        uint256 oldRoot = issuerRegistry.getIssuerRoot(registryId);

        vm.warp(block.timestamp + 30 days);
        add(registryId, B);

        assertEq(issuerRegistry.getRootSupersededAt(registryId, oldRoot), block.timestamp);
        assertTrue(issuerRegistry.isValidRoot(registryId, oldRoot));
    }

    function test_theEmptyRootIsNeverStamped() public {
        add(registryId, A);

        assertEq(issuerRegistry.getRootSupersededAt(registryId, 0), 0);
    }

    function test_getRootSupersededAt_isZeroWhileARootIsCurrent() public {
        add(registryId, A);

        assertEq(issuerRegistry.getRootSupersededAt(registryId, issuerRegistry.getIssuerRoot(registryId)), 0);
    }

    function test_aRootThatBecomesCurrentAgainIsNoLongerStamped() public {
        add(registryId, A);
        add(registryId, B);
        uint256 original = issuerRegistry.getIssuerRoot(registryId);

        update(registryId, B, C);
        assertEq(issuerRegistry.getRootSupersededAt(registryId, original), block.timestamp);

        vm.warp(block.timestamp + 1 days);
        update(registryId, C, B);

        assertEq(issuerRegistry.getIssuerRoot(registryId), original);
        assertEq(issuerRegistry.getRootSupersededAt(registryId, original), 0);
        assertTrue(issuerRegistry.isValidRoot(registryId, original));

        add(registryId, C);

        assertEq(issuerRegistry.getRootSupersededAt(registryId, original), block.timestamp);
        assertTrue(issuerRegistry.isValidRoot(registryId, original));
    }

    function test_everyMutationSupersedesThePreviousRoot() public {
        add(registryId, A);
        add(registryId, B);

        uint256 rootBeforeBatch = issuerRegistry.getIssuerRoot(registryId);
        uint256[] memory commitments = new uint256[](1);
        commitments[0] = C;

        vm.warp(1 days);
        vm.prank(admin);
        issuerRegistry.addIssuers(registryId, commitments);

        assertEq(issuerRegistry.getRootSupersededAt(registryId, rootBeforeBatch), 1 days);

        uint256 rootBeforeRemoval = issuerRegistry.getIssuerRoot(registryId);

        vm.warp(2 days);
        remove(registryId, B);

        assertEq(issuerRegistry.getRootSupersededAt(registryId, rootBeforeRemoval), 2 days);

        uint256 rootBeforeUpdate = issuerRegistry.getIssuerRoot(registryId);

        vm.warp(3 days);
        update(registryId, A, B);

        assertEq(issuerRegistry.getRootSupersededAt(registryId, rootBeforeUpdate), 3 days);
    }

    function test_aRemovedIssuerKeepsVerifyingForTheWindow() public {
        add(registryId, A);
        add(registryId, B);
        uint256 rootWithA = issuerRegistry.getIssuerRoot(registryId);

        remove(registryId, A);

        assertTrue(issuerRegistry.isValidRoot(registryId, rootWithA));

        vm.warp(block.timestamp + issuerRegistry.DEFAULT_ROOT_DURATION());

        assertFalse(issuerRegistry.isValidRoot(registryId, rootWithA));
    }

    function test_expireRegistryRoots_rejectsEverySupersededRootAtOnce() public {
        add(registryId, A);
        uint256 first = issuerRegistry.getIssuerRoot(registryId);

        add(registryId, B);
        uint256 second = issuerRegistry.getIssuerRoot(registryId);

        remove(registryId, A);
        uint256 current = issuerRegistry.getIssuerRoot(registryId);

        vm.expectEmit(true, false, false, false);
        emit IIssuerRegistry.RegistryRootsExpired(registryId);

        vm.prank(admin);
        issuerRegistry.expireRegistryRoots(registryId);

        assertEq(issuerRegistry.getRegistryRootsExpiredAt(registryId), block.timestamp);
        assertFalse(issuerRegistry.isValidRoot(registryId, first));
        assertFalse(issuerRegistry.isValidRoot(registryId, second));
        assertTrue(issuerRegistry.isValidRoot(registryId, current));
    }

    function test_expireRegistryRoots_leavesLaterRootsTheirWindow() public {
        add(registryId, A);

        vm.prank(admin);
        issuerRegistry.expireRegistryRoots(registryId);

        vm.warp(block.timestamp + 1);
        uint256 rootBefore = issuerRegistry.getIssuerRoot(registryId);
        add(registryId, B);

        assertTrue(issuerRegistry.isValidRoot(registryId, rootBefore));
    }

    function test_expireRegistryRoots_outranksARaisedWindow() public {
        add(registryId, A);
        uint256 oldRoot = issuerRegistry.getIssuerRoot(registryId);
        add(registryId, B);

        vm.startPrank(admin);
        issuerRegistry.expireRegistryRoots(registryId);
        issuerRegistry.updateRegistryRootDuration(registryId, type(uint256).max);
        vm.stopPrank();

        assertFalse(issuerRegistry.isValidRoot(registryId, oldRoot));
    }

    function test_expireRegistryRoots_rejectsARootRemovedInTheSameBlock() public {
        add(registryId, A);
        add(registryId, B);
        uint256 rootWithA = issuerRegistry.getIssuerRoot(registryId);

        remove(registryId, A);

        vm.prank(admin);
        issuerRegistry.expireRegistryRoots(registryId);

        assertEq(
            issuerRegistry.getRootSupersededAt(registryId, rootWithA),
            issuerRegistry.getRegistryRootsExpiredAt(registryId)
        );
        assertFalse(issuerRegistry.isValidRoot(registryId, rootWithA));
    }

    function test_expireRegistryRoots_leavesTheCurrentRootItsWindowAfterAWriteInTheSameBlock() public {
        add(registryId, A);
        add(registryId, B);
        uint256 rootWithA = issuerRegistry.getIssuerRoot(registryId);

        remove(registryId, A);
        uint256 rootAtExpiry = issuerRegistry.getIssuerRoot(registryId);

        vm.prank(admin);
        issuerRegistry.expireRegistryRoots(registryId);

        add(registryId, C);
        uint256 rootWithC = issuerRegistry.getIssuerRoot(registryId);

        add(registryId, A);

        assertTrue(issuerRegistry.isValidRoot(registryId, rootAtExpiry));
        assertFalse(issuerRegistry.isValidRoot(registryId, rootWithA));
        // Superseded within the block, so no holder could have synced it.
        assertFalse(issuerRegistry.isValidRoot(registryId, rootWithC));

        vm.warp(block.timestamp + issuerRegistry.DEFAULT_ROOT_DURATION());

        assertFalse(issuerRegistry.isValidRoot(registryId, rootAtExpiry));
    }

    function test_expireRegistryRoots_isOnlyForTheRegistryAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IIssuerRegistries.CallerIsNotTheRegistryAdmin.selector);
        issuerRegistry.expireRegistryRoots(registryId);
    }
}
