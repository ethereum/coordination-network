// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";

import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { NetworkMemberGovernance } from "../../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { ISafeGovernance } from "../../src/interfaces/ISafeGovernance.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract NetworkMemberGovernanceUnitTest is NetworkMemberRegistryTestBase {
    NetworkMemberGovernance internal governance;
    NetworkMemberRegistry internal governedRegistry;
    NetworkMemberGroup internal governedGroup;

    function _setUpGovernance(uint256 foundingMembers) internal {
        _deployGovernanceSafe(foundingMembers);
        governedRegistry = new NetworkMemberRegistry(address(safe));
        governedGroup = _deployNetworkMemberGroup(address(safe));
        governance = new NetworkMemberGovernance(ISafeGovernance(address(safe)), governedRegistry, governedGroup);
        _enableSafeModule(address(governance));

        // Removal retires the member's issuer keys atomically, so a removal-path test needs the set
        // wired the same way production does.
        ApprovedIssuerSet governedIssuerSet = new ApprovedIssuerSet(address(governedRegistry));
        vm.prank(address(safe));
        governedRegistry.setApprovedIssuerSet(address(governedIssuerSet));
    }

    function test_GovernanceThreshold_IsAMajorityOfTheMembers() public {
        _setUpGovernance(5);

        assertEq(governance.governanceThreshold(2), 2);
        assertEq(governance.governanceThreshold(3), 2);
        assertEq(governance.governanceThreshold(5), 3);
        assertEq(governance.governanceThreshold(6), 4);
        assertEq(governance.governanceThreshold(8), 5);
        // Five members today, so an admission will require four.
        assertEq(governance.thresholdAfterAdmission(), 4);
    }

    function test_Constructor_RevertsWhen_AnyAddressIsZero() public {
        _deployGovernanceSafe(5);
        NetworkMemberRegistry registryOnly = new NetworkMemberRegistry(address(safe));
        NetworkMemberGroup groupOnly = _deployNetworkMemberGroup(address(safe));

        vm.expectRevert(NetworkMemberGovernance.ZeroAddress.selector);
        new NetworkMemberGovernance(ISafeGovernance(address(0)), registryOnly, groupOnly);

        vm.expectRevert(NetworkMemberGovernance.ZeroAddress.selector);
        new NetworkMemberGovernance(ISafeGovernance(address(safe)), NetworkMemberRegistry(address(0)), groupOnly);

        vm.expectRevert(NetworkMemberGovernance.ZeroAddress.selector);
        new NetworkMemberGovernance(ISafeGovernance(address(safe)), registryOnly, NetworkMemberGroup(address(0)));
    }

    /// @dev The one line that confines the module's power. Nobody but the Safe may reach any operation,
    /// so every one carries a majority of the members' signatures.
    function test_AdmitMember_RevertsWhen_CallerIsNotTheSafe() public {
        _setUpGovernance(5);

        uint256 memberCount = safe.getOwners().length;
        address singleOwner = safe.getOwners()[0];

        vm.expectRevert(NetworkMemberGovernance.OnlyGovernanceSafe.selector);
        vm.prank(makeAddr("attacker"));
        governance.admitMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, memberCount
        );

        // Not even one of the Safe's own owners, acting alone.
        vm.expectRevert(NetworkMemberGovernance.OnlyGovernanceSafe.selector);
        vm.prank(singleOwner);
        governance.admitMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, memberCount
        );
    }

    function test_RemoveMember_RevertsWhen_CallerIsNotTheSafe() public {
        _setUpGovernance(5);

        uint256 memberCount = safe.getOwners().length;

        vm.expectRevert(NetworkMemberGovernance.OnlyGovernanceSafe.selector);
        vm.prank(makeAddr("attacker"));
        governance.removeMember(memberNetworkId, new uint256[](0), memberCount);
    }

    function test_AdmitMember_RevertsWhen_KeyIsNotOnTheCurve() public {
        _setUpGovernance(5);

        uint256 memberCount = safe.getOwners().length;

        vm.expectRevert(
            abi.encodeWithSelector(
                NetworkMemberGovernance.SafeCallFailed.selector,
                abi.encodeWithSelector(NetworkMemberRegistry.AccountKeyNotOnCurve.selector)
            )
        );
        vm.prank(address(safe));
        governance.admitMember(
            networkMember.publicKeyX, networkMember.publicKeyY + 1, semaphoreCommitment, governanceSigner, memberCount
        );
    }

    /// @dev The event carries the id the registry derives from the key, since the call no longer takes one.
    function test_AdmitMember_EmitsTheIdDerivedFromTheKey() public {
        _setUpGovernance(5);

        uint256 memberCount = safe.getOwners().length;

        vm.expectEmit(true, false, false, true, address(governance));
        emit NetworkMemberGovernance.NetworkMemberAdmitted(
            keccak256(abi.encodePacked(networkMember.publicKeyX, networkMember.publicKeyY)),
            governanceSigner,
            governance.governanceThreshold(memberCount + 1)
        );
        vm.prank(address(safe));
        governance.admitMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, memberCount
        );
    }

    function test_AdmitMember_WritesAllThreePlacesInOneCall() public {
        _setUpGovernance(5);

        _execFromSafe(
            address(governance),
            abi.encodeCall(
                NetworkMemberGovernance.admitMember,
                (
                    networkMember.publicKeyX,
                    networkMember.publicKeyY,
                    semaphoreCommitment,
                    governanceSigner,
                    safe.getOwners().length
                )
            ),
            safe.getThreshold()
        );

        assertTrue(governedRegistry.isApproved(memberNetworkId));
        assertEq(governedRegistry.governanceSignerOf(memberNetworkId), governanceSigner);
        assertTrue(governedGroup.hasNetworkMember(semaphoreCommitment));
        assertTrue(safe.isOwner(governanceSigner));
        // Six members now, so four signatures.
        assertEq(safe.getOwners().length, 6);
        assertEq(safe.getThreshold(), 4);
    }

    /// @dev The threshold is computed, not supplied, so there is no argument a caller could use to
    /// lower it. The only inputs are the member's own four values.
    function test_AdmitMember_ThresholdIsNotAnInput() public {
        _setUpGovernance(5);

        _execFromSafe(
            address(governance),
            abi.encodeCall(
                NetworkMemberGovernance.admitMember,
                (
                    networkMember.publicKeyX,
                    networkMember.publicKeyY,
                    semaphoreCommitment,
                    governanceSigner,
                    safe.getOwners().length
                )
            ),
            safe.getThreshold()
        );

        assertEq(safe.getThreshold(), governance.governanceThreshold(safe.getOwners().length));
    }

    /// @dev The registry's own guard, bubbled back out of the Safe's module call so a failed
    /// governance operation stays diagnosable.
    function test_AdmitMember_RevertsWhen_AlreadyApproved() public {
        _setUpGovernance(5);
        _admitThroughGovernance();

        uint256 memberCount = safe.getOwners().length;

        vm.expectRevert(
            abi.encodeWithSelector(
                NetworkMemberGovernance.SafeCallFailed.selector,
                abi.encodeWithSelector(NetworkMemberRegistry.AlreadyApproved.selector, memberNetworkId)
            )
        );
        vm.prank(address(safe));
        governance.admitMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, memberCount
        );
    }

    function test_RemoveMember_TakesTheMemberOutOfAllThreePlaces() public {
        _setUpGovernance(5);
        _admitThroughGovernance();

        _execFromSafe(
            address(governance),
            abi.encodeCall(
                NetworkMemberGovernance.removeMember, (memberNetworkId, new uint256[](0), safe.getOwners().length)
            ),
            safe.getThreshold()
        );

        assertFalse(governedRegistry.isApproved(memberNetworkId));
        assertFalse(governedGroup.hasNetworkMember(semaphoreCommitment));
        assertFalse(safe.isOwner(governanceSigner));
        // Back to five members, so back to three signatures.
        assertEq(safe.getOwners().length, 5);
        assertEq(safe.getThreshold(), 3);
    }

    function test_RemoveMember_RevertsWhen_NotApproved() public {
        _setUpGovernance(5);

        uint256 memberCount = safe.getOwners().length;

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.NotApproved.selector, memberNetworkId));
        vm.prank(address(safe));
        governance.removeMember(memberNetworkId, new uint256[](0), memberCount);
    }

    /// @dev A member whose seat is already gone reports that, rather than whatever the floor check
    /// would conclude about a set it is not part of.
    function test_RemoveMember_RevertsWhen_TheMemberHasNoSeat() public {
        _setUpGovernance(5);
        _admitThroughGovernance();

        // Governance drops the seat on its own, leaving the record behind.
        _execFromSafe(
            address(safe),
            abi.encodeWithSignature(
                "removeOwner(address,address,uint256)", _prevOwnerOf(governanceSigner), governanceSigner, 3
            ),
            safe.getThreshold()
        );
        assertFalse(safe.isOwner(governanceSigner));

        uint256 memberCount = safe.getOwners().length;

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.NotASafeOwner.selector, governanceSigner));
        vm.prank(address(safe));
        governance.removeMember(memberNetworkId, new uint256[](0), memberCount);
    }

    /// @dev A set may shrink back to a single member. Growth is reversible, so a network that reached
    /// three and lost two is left where it started rather than stuck at a size it cannot leave.
    function test_RemoveMember_ShrinksBackToASingleMember() public {
        _setUpGovernance(1);
        _admitThroughGovernance();
        assertEq(safe.getOwners().length, 2);
        assertEq(safe.getThreshold(), 2);

        // Pranked as the Safe: the quorum here is the founding member plus the member being removed,
        // and only the founder's key exists in this fixture.
        uint256 memberCount = safe.getOwners().length;
        vm.prank(address(safe));
        governance.removeMember(memberNetworkId, new uint256[](0), memberCount);

        // Back to the founding member alone, who now signs for itself.
        assertEq(safe.getOwners().length, 1);
        assertEq(safe.getThreshold(), 1);
        assertFalse(governedRegistry.isApproved(memberNetworkId));
        assertFalse(governedGroup.hasNetworkMember(semaphoreCommitment));
        assertFalse(safe.isOwner(governanceSigner));
    }

    /// @dev The floor is one, never zero: an ownerless Safe could never admit a member again, and the
    /// registry and the group would be frozen behind it with no path back.
    function test_ExitNetwork_RevertsWhen_ItWouldEmptyTheSet() public {
        _setUpGovernance(1);

        // The founding member seats itself, as phase 0 of the runbook does: the Safe owns the registry,
        // so it writes the record directly and its own owner becomes that member's governance signer.
        address foundingSigner = safeSigners[0].addr;
        _execFromSafe(
            address(governedRegistry),
            abi.encodeCall(
                NetworkMemberRegistry.approveNetworkMember,
                (networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, foundingSigner)
            ),
            safe.getThreshold()
        );
        assertEq(safe.getOwners().length, 1);

        // The sole member cannot leave: there would be nobody left to admit anyone ever again.
        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.MemberSetTooSmall.selector, 0));
        vm.prank(foundingSigner);
        governance.exitNetwork(memberNetworkId, new uint256[](0));

        assertTrue(governedRegistry.isApproved(memberNetworkId));
        assertTrue(safe.isOwner(foundingSigner));
    }

    /// @dev Shrinking to exactly the floor is allowed, and both remaining members must then sign.
    function test_RemoveMember_ShrinksToTheFloor() public {
        _setUpGovernance(2);
        _admitThroughGovernance();
        assertEq(safe.getOwners().length, 3);

        _execFromSafe(
            address(governance),
            abi.encodeCall(
                NetworkMemberGovernance.removeMember, (memberNetworkId, new uint256[](0), safe.getOwners().length)
            ),
            safe.getThreshold()
        );

        assertEq(safe.getOwners().length, 2);
        assertEq(safe.getThreshold(), 2);
        assertFalse(governedRegistry.isApproved(memberNetworkId));
        assertFalse(safe.isOwner(governanceSigner));
    }

    function test_ExitNetwork_LeavesWithoutAskingTheOtherMembers() public {
        _setUpGovernance(5);
        _admitThroughGovernance();
        assertEq(safe.getOwners().length, 6);
        assertEq(safe.getThreshold(), 4);

        // One transaction, from the member's own governance signer. No quorum, nothing to approve.
        vm.expectEmit();
        emit NetworkMemberGovernance.NetworkMemberExited(memberNetworkId, governanceSigner, 3);
        vm.prank(governanceSigner);
        governance.exitNetwork(memberNetworkId, new uint256[](0));

        assertFalse(governedRegistry.isApproved(memberNetworkId));
        assertFalse(governedGroup.hasNetworkMember(semaphoreCommitment));
        assertFalse(safe.isOwner(governanceSigner));
        // Five members again, so three signatures: the departing member freed its own seat rather than
        // leaving one nobody can sign for.
        assertEq(safe.getOwners().length, 5);
        assertEq(safe.getThreshold(), 3);
    }

    /// @dev The invariant that confines the one door not gated on the Safe: a caller may act on its own
    /// membership and no other. A member's governance signer is powerless against anyone else.
    function test_ExitNetwork_RevertsWhen_CallerIsAnotherMembersSigner() public {
        _setUpGovernance(5);
        _admitThroughGovernance();

        Vm.Wallet memory secondMember = vm.createWallet("secondMember");
        address secondSigner = makeAddr("secondGovernanceSigner");
        _execFromSafe(
            address(governance),
            abi.encodeCall(
                NetworkMemberGovernance.admitMember,
                (
                    secondMember.publicKeyX,
                    secondMember.publicKeyY,
                    _semaphoreCommitment("secondMember"),
                    secondSigner,
                    safe.getOwners().length
                )
            ),
            safe.getThreshold()
        );

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.OnlyGovernanceSigner.selector, memberNetworkId));
        vm.prank(secondSigner);
        governance.exitNetwork(memberNetworkId, new uint256[](0));

        assertTrue(governedRegistry.isApproved(memberNetworkId));
        assertTrue(safe.isOwner(governanceSigner));
    }

    function test_ExitNetwork_RevertsWhen_CallerIsTheAuthKeyOrAStranger() public {
        _setUpGovernance(5);
        _admitThroughGovernance();

        // The auth key is a hot server key, and deliberately cannot destroy the membership.
        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.OnlyGovernanceSigner.selector, memberNetworkId));
        vm.prank(networkMember.addr);
        governance.exitNetwork(memberNetworkId, new uint256[](0));

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.OnlyGovernanceSigner.selector, memberNetworkId));
        vm.prank(makeAddr("attacker"));
        governance.exitNetwork(memberNetworkId, new uint256[](0));
    }

    function test_ExitNetwork_RevertsWhen_NotApproved() public {
        _setUpGovernance(5);

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.NotApproved.selector, memberNetworkId));
        vm.prank(governanceSigner);
        governance.exitNetwork(memberNetworkId, new uint256[](0));
    }

    /// @dev Leaving a pair is allowed, and hands the remaining member a threshold of one rather than
    /// leaving a seat nobody can sign for.
    function test_ExitNetwork_LeavesAPairWithASingleMember() public {
        _setUpGovernance(1);
        _admitThroughGovernance();
        assertEq(safe.getOwners().length, 2);

        vm.expectEmit();
        emit NetworkMemberGovernance.NetworkMemberExited(memberNetworkId, governanceSigner, 1);
        vm.prank(governanceSigner);
        governance.exitNetwork(memberNetworkId, new uint256[](0));

        assertEq(safe.getOwners().length, 1);
        assertEq(safe.getThreshold(), 1);
        assertFalse(safe.isOwner(governanceSigner));
    }

    /// @dev Without the module enabled the Safe refuses to act for this contract, so an admission
    /// fails rather than half-landing.
    function test_AdmitMember_RevertsWhen_ModuleIsNotEnabled() public {
        _deployGovernanceSafe(5);
        governedRegistry = new NetworkMemberRegistry(address(safe));
        governedGroup = _deployNetworkMemberGroup(address(safe));
        governance = new NetworkMemberGovernance(ISafeGovernance(address(safe)), governedRegistry, governedGroup);

        uint256 memberCount = safe.getOwners().length;

        // GS104 is the Safe's "method can only be called from an enabled module".
        vm.expectRevert(bytes("GS104"));
        vm.prank(address(safe));
        governance.admitMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, memberCount
        );

        assertFalse(governedRegistry.isApproved(memberNetworkId));
    }

    /// @dev The Safe can lower its own threshold directly. The module cannot stop that, but it refuses
    /// to admit anyone on top of it, so the drift surfaces instead of persisting.
    function test_AdmitMember_RevertsWhen_ThresholdWasLoweredDirectly() public {
        _setUpGovernance(5);
        vm.prank(address(safe));
        safe.changeThreshold(1);

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.ThresholdMismatch.selector, 3, 1));
        vm.prank(address(safe));
        governance.admitMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, 5
        );
    }

    /// @dev A raised threshold is drift too: the module would silently reset it on its next operation.
    function test_RemoveMember_RevertsWhen_ThresholdWasRaisedDirectly() public {
        _setUpGovernance(5);
        _admitThroughGovernance();
        vm.prank(address(safe));
        safe.changeThreshold(6);

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.ThresholdMismatch.selector, 4, 6));
        vm.prank(address(safe));
        governance.removeMember(memberNetworkId, new uint256[](0), 6);
    }

    /// @dev The repair is one direct `changeThreshold` back to the majority.
    function test_AdmitMember_SucceedsOnceThresholdIsRestored() public {
        _setUpGovernance(5);
        vm.prank(address(safe));
        safe.changeThreshold(1);
        vm.prank(address(safe));
        safe.changeThreshold(3);

        _admitThroughGovernance();

        assertTrue(governedRegistry.isApproved(memberNetworkId));
        assertEq(safe.getThreshold(), 4);
    }

    /// @dev Exit stays open while the threshold has drifted: a member must always be able to leave,
    /// and the exit sets the threshold back to the majority as it goes.
    function test_ExitNetwork_SucceedsWhileThresholdHasDrifted() public {
        _setUpGovernance(5);
        _admitThroughGovernance();
        vm.prank(address(safe));
        safe.changeThreshold(1);

        vm.prank(governanceSigner);
        governance.exitNetwork(memberNetworkId, new uint256[](0));

        assertEq(safe.getThreshold(), 3);
    }

    function _admitThroughGovernance() internal {
        _execFromSafe(
            address(governance),
            abi.encodeCall(
                NetworkMemberGovernance.admitMember,
                (
                    networkMember.publicKeyX,
                    networkMember.publicKeyY,
                    semaphoreCommitment,
                    governanceSigner,
                    safe.getOwners().length
                )
            ),
            safe.getThreshold()
        );
    }
}
