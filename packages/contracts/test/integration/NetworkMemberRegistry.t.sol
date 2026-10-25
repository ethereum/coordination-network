// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract NetworkMemberRegistryIntegrationTest is NetworkMemberRegistryTestBase {
    /// @dev A removed member leaves nothing behind, and re-approving it rebuilds the whole record from
    /// the approval's own arguments rather than from anything the removal left in storage.
    function test_RemoveThenReApprove_RestoresTheWholeRecord() public {
        _approveMember();
        _removeMember();

        assertFalse(registry.isApproved(memberNetworkId));
        assertEq(registry.networkMemberAuthAddress(memberNetworkId), address(0));
        assertEq(registry.semaphoreCommitmentOf(memberNetworkId), 0);
        assertEq(registry.governanceSignerOf(memberNetworkId), address(0));

        _approveMember();

        assertTrue(registry.isApproved(memberNetworkId));
        assertEq(registry.networkMemberAuthAddress(memberNetworkId), networkMember.addr);
        assertEq(registry.semaphoreCommitmentOf(memberNetworkId), semaphoreCommitment);
        assertEq(registry.governanceSignerOf(memberNetworkId), governanceSigner);
    }

    /// @dev The whole lifecycle against both real contracts, no mocks. The auth address publishes,
    /// governance can publish and retire alongside it, and removal retires whatever is left
    /// atomically: a verifier can no longer prove membership under the pre-removal root.
    function test_IssuerKeyLifecycle_PublishRetireAndAtomicRemoval() public {
        _approveMember();

        vm.prank(networkMember.addr);
        uint256 firstLeaf = issuerSet.publishIssuerKey(memberNetworkId, KEY_1_X, KEY_1_Y);
        assertTrue(issuerSet.isApprovedIssuerKey(firstLeaf));

        // Governance can publish for the member too, alongside the auth address.
        vm.prank(owner);
        uint256 secondLeaf = issuerSet.publishIssuerKey(memberNetworkId, KEY_2_X, KEY_2_Y);
        assertTrue(issuerSet.isApprovedIssuerKey(secondLeaf));
        assertEq(issuerSet.issuerKeysOf(memberNetworkId).length, 2);

        // Governance can retire a key too, ending its life without waiting for removal.
        vm.prank(owner);
        issuerSet.retireIssuerKey(memberNetworkId, firstLeaf);
        assertFalse(issuerSet.isApprovedIssuerKey(firstLeaf));
        assertEq(issuerSet.issuerKeysOf(memberNetworkId).length, 1);

        uint256 rootBeforeRemoval = issuerSet.issuerSetRoot();
        assertTrue(issuerSet.isValidIssuerSetRoot(rootBeforeRemoval));

        _removeMember();

        assertFalse(issuerSet.isApprovedIssuerKey(secondLeaf));
        assertEq(issuerSet.issuerKeysOf(memberNetworkId).length, 0);
        assertFalse(issuerSet.isValidIssuerSetRoot(rootBeforeRemoval));
    }

    /// @dev The root the removed member's key was live under has to stop being accepted in the same
    /// transaction. Granting it the ordinary grace window would hand the member the window back: it
    /// still holds the key and the path, so it could keep signing new credentials and proving them
    /// against that root, and issuer anonymity means nobody could tell it was happening.
    function test_RemoveNetworkMember_StopsAcceptingTheRootTheRetiredKeyWasLiveUnder() public {
        _approveMember();
        vm.prank(networkMember.addr);
        issuerSet.publishIssuerKey(memberNetworkId, KEY_1_X, KEY_1_Y);

        uint256 rootWithKey = issuerSet.issuerSetRoot();
        assertTrue(issuerSet.isValidIssuerSetRoot(rootWithKey));

        _removeMember();

        assertFalse(issuerSet.isValidIssuerSetRoot(rootWithKey));
    }

    function test_SetApprovedIssuerSet_RevertsWhen_CallerNotOwner() public {
        NetworkMemberRegistry unwired = new NetworkMemberRegistry(owner);
        ApprovedIssuerSet set = new ApprovedIssuerSet(address(unwired));
        address attacker = makeAddr("attacker");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        unwired.setApprovedIssuerSet(address(set));
    }
}
