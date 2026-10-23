// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract NetworkMemberRegistryUnitTest is NetworkMemberRegistryTestBase {
    uint256 internal constant SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
    uint256 internal constant G_X = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798;
    uint256 internal constant G_Y = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8;

    /// @dev Two points with one coordinate small enough that adding the field prime stays below 2^256,
    /// so the other representative of the same residue can be passed in. Both satisfy y^2 = x^3 + 7.
    uint256 internal constant SMALL_X = 1;
    uint256 internal constant SMALL_X_Y = 0x4218F20AE6C646B363DB68605822FB14264CA8D2587FDD6FBC750D587E76A7EE;
    uint256 internal constant SMALL_Y = 1;
    uint256 internal constant SMALL_Y_X = 0x1FE1E5EF3FCEB5C135AB7741333CE5A6E80D68167653F6B2B24BCBCFAAAFF507;

    function test_IsApproved_ReturnsFalseForUnknownNetworkId() public view {
        assertFalse(registry.isApproved(memberNetworkId));
    }

    function test_MemberNetworkIdOf_HashesTheKeyCoordinates() public view {
        assertEq(
            registry.memberNetworkIdOf(networkMember.publicKeyX, networkMember.publicKeyY),
            keccak256(abi.encodePacked(networkMember.publicKeyX, networkMember.publicKeyY))
        );
    }

    function test_ApproveNetworkMember_RecordsTheKeyAddressAsAuthAddress() public {
        _approveMember();

        assertEq(registry.networkMemberAuthAddress(memberNetworkId), networkMember.addr);
    }

    function test_ApproveNetworkMember_RevertsWhen_KeyIsNotOnTheCurve() public {
        uint256 x = networkMember.publicKeyX;
        uint256 y = networkMember.publicKeyY;

        _expectApproveRevertsOffCurve(x, y + 1);
        _expectApproveRevertsOffCurve(SECP256K1_P, y);
        _expectApproveRevertsOffCurve(x, SECP256K1_P);
        _expectApproveRevertsOffCurve(0, 0);
    }

    function test_RequestToJoin_RevertsWhen_KeyIsNotOnTheCurve() public {
        uint256 x = networkMember.publicKeyX;
        uint256 y = networkMember.publicKeyY;

        _expectRequestRevertsOffCurve(x, y + 1);
        _expectRequestRevertsOffCurve(SECP256K1_P, y);
        _expectRequestRevertsOffCurve(x, SECP256K1_P);
        _expectRequestRevertsOffCurve(0, 0);
    }

    function test_RequestToJoin_RevertsWhen_CallerHoldsAnotherKey() public {
        Vm.Wallet memory other = vm.createWallet("someOtherAccountKey");

        vm.expectRevert(NetworkMemberRegistry.UnauthorizedCaller.selector);
        vm.prank(other.addr);
        registry.requestToJoin(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, ""
        );
    }

    /// @dev The curve is symmetric in y, so the reflected point is a different valid key with its own
    /// id and auth address.
    function test_ApproveNetworkMember_AcceptsTheReflectedKeyAsADifferentMember() public {
        bytes32 reflectedId = registry.memberNetworkIdOf(G_X, SECP256K1_P - G_Y);

        vm.startPrank(owner);
        registry.approveNetworkMember(G_X, G_Y, semaphoreCommitment, governanceSigner);
        registry.approveNetworkMember(G_X, SECP256K1_P - G_Y, semaphoreCommitment, governanceSigner);
        vm.stopPrank();

        assertTrue(registry.isApproved(registry.memberNetworkIdOf(G_X, G_Y)));
        assertTrue(registry.isApproved(reflectedId));
        assertTrue(reflectedId != registry.memberNetworkIdOf(G_X, G_Y));
    }

    /// @dev The curve equation reduces mod P, so a coordinate P larger than a real one satisfies it too.
    /// Only the explicit range check rejects it, and accepting it would give one key a second id.
    function test_ApproveNetworkMember_RevertsWhen_ACoordinateIsNotReducedModP() public {
        vm.prank(owner);
        registry.approveNetworkMember(SMALL_X, SMALL_X_Y, semaphoreCommitment, governanceSigner);
        vm.prank(owner);
        registry.approveNetworkMember(SMALL_Y_X, SMALL_Y, semaphoreCommitment, governanceSigner);

        _expectApproveRevertsOffCurve(SMALL_X + SECP256K1_P, SMALL_X_Y);
        _expectApproveRevertsOffCurve(SMALL_Y_X, SMALL_Y + SECP256K1_P);
    }

    function test_RequestToJoin_RevertsWhen_ACoordinateIsNotReducedModP() public {
        _expectRequestRevertsOffCurve(SMALL_X + SECP256K1_P, SMALL_X_Y);
        _expectRequestRevertsOffCurve(SMALL_Y_X, SMALL_Y + SECP256K1_P);
    }

    /// @dev The unwired check comes first on the approval path, ahead of the curve check.
    function test_ApproveNetworkMember_ChecksTheSetIsWiredBeforeTheKey() public {
        NetworkMemberRegistry unwired = new NetworkMemberRegistry(owner);

        vm.expectRevert(NetworkMemberRegistry.IssuerSetNotWired.selector);
        vm.prank(owner);
        unwired.approveNetworkMember(0, 0, semaphoreCommitment, governanceSigner);
    }

    /// @dev The caller check comes before the already-approved check.
    function test_RequestToJoin_RevertsUnauthorizedBeforeAlreadyApproved() public {
        _approveMember();

        vm.expectRevert(NetworkMemberRegistry.UnauthorizedCaller.selector);
        vm.prank(makeAddr("attacker"));
        registry.requestToJoin(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, ""
        );
    }

    function test_RequestToJoin_RevertsAlreadyApprovedBeforeTheZeroChecks() public {
        _approveMember();

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberRegistry.AlreadyApproved.selector, memberNetworkId));
        vm.prank(networkMember.addr);
        registry.requestToJoin(networkMember.publicKeyX, networkMember.publicKeyY, 0, address(0), "");
    }

    function _expectApproveRevertsOffCurve(uint256 x, uint256 y) internal {
        vm.expectRevert(NetworkMemberRegistry.AccountKeyNotOnCurve.selector);
        vm.prank(owner);
        registry.approveNetworkMember(x, y, semaphoreCommitment, governanceSigner);
    }

    function _expectRequestRevertsOffCurve(uint256 x, uint256 y) internal {
        vm.expectRevert(NetworkMemberRegistry.AccountKeyNotOnCurve.selector);
        vm.prank(networkMember.addr);
        registry.requestToJoin(x, y, semaphoreCommitment, governanceSigner, "");
    }

    function test_ApproveNetworkMember_RevertsWhen_CallerNotGovernance() public {
        address attacker = makeAddr("attacker");

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        registry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner
        );
    }

    function test_ApproveNetworkMember_RevertsWhen_AlreadyApproved() public {
        _approveMember();

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberRegistry.AlreadyApproved.selector, memberNetworkId));
        vm.prank(owner);
        registry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner
        );
    }

    /// @dev Without a wired set, an approved member would sit in a state {removeNetworkMember} can
    /// never remove it from: that function refuses to run while the set is unwired.
    function test_ApproveNetworkMember_RevertsWhen_IssuerSetNotWired() public {
        NetworkMemberRegistry unwired = new NetworkMemberRegistry(owner);

        vm.expectRevert(NetworkMemberRegistry.IssuerSetNotWired.selector);
        vm.prank(owner);
        unwired.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner
        );

        assertFalse(unwired.isApproved(memberNetworkId));
    }

    function test_ApproveNetworkMember_ApprovesMember() public {
        vm.expectEmit();
        emit NetworkMemberRegistry.NetworkMemberApproved(memberNetworkId);
        vm.prank(owner);
        registry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner
        );

        assertTrue(registry.isApproved(memberNetworkId));
        assertEq(registry.networkMemberAuthAddress(memberNetworkId), networkMember.addr);
    }

    function test_RemoveNetworkMember_RevertsWhen_CallerNotGovernance() public {
        _approveMember();

        address attacker = makeAddr("attacker");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, attacker));
        vm.prank(attacker);
        registry.removeNetworkMember(memberNetworkId);
    }

    function test_RemoveNetworkMember_RevertsWhen_NotApproved() public {
        vm.expectRevert(abi.encodeWithSelector(NetworkMemberRegistry.NotApproved.selector, memberNetworkId));
        _removeMember();
    }

    function test_RemoveNetworkMember_RemovesMember() public {
        _approveMember();
        vm.prank(networkMember.addr);
        registry.registerNetworkMemberIdentity(memberNetworkId, metaStealthAddress);

        vm.expectEmit();
        emit NetworkMemberRegistry.NetworkMemberRemoved(memberNetworkId);
        _removeMember();

        assertFalse(registry.isApproved(memberNetworkId));
        assertEq(registry.networkMemberAuthAddress(memberNetworkId), address(0));
        assertEq(registry.identity(memberNetworkId).length, 0);
    }

    function test_RegisterNetworkMemberIdentity_RevertsWhen_CallerNotAuthAddressOrGovernance() public {
        _approveMember();

        vm.expectRevert(NetworkMemberRegistry.UnauthorizedCaller.selector);
        vm.prank(makeAddr("attacker"));
        registry.registerNetworkMemberIdentity(memberNetworkId, metaStealthAddress);
    }

    function test_RegisterNetworkMemberIdentity_RevertsWhen_MemberRemoved() public {
        _approveMember();
        _removeMember();

        vm.expectRevert(NetworkMemberRegistry.UnauthorizedCaller.selector);
        vm.prank(networkMember.addr);
        registry.registerNetworkMemberIdentity(memberNetworkId, metaStealthAddress);
    }

    function test_RegisterNetworkMemberIdentity_RevertsWhen_NotApproved() public {
        vm.expectRevert(abi.encodeWithSelector(NetworkMemberRegistry.NotApproved.selector, memberNetworkId));
        vm.prank(owner);
        registry.registerNetworkMemberIdentity(memberNetworkId, metaStealthAddress);
    }

    function test_RegisterNetworkMemberIdentity_RevertsWhen_GovernanceWritesRemovedMember() public {
        _approveMember();
        _removeMember();

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberRegistry.NotApproved.selector, memberNetworkId));
        vm.prank(owner);
        registry.registerNetworkMemberIdentity(memberNetworkId, metaStealthAddress);
    }

    function test_RegisterNetworkMemberIdentity_RevertsWhen_WrongLength() public {
        _approveMember();

        bytes memory wrongLengthMeta = new bytes(65);
        vm.expectRevert(NetworkMemberRegistry.InvalidMetaStealthAddressLength.selector);
        vm.prank(networkMember.addr);
        registry.registerNetworkMemberIdentity(memberNetworkId, wrongLengthMeta);
    }

    function test_RegisterNetworkMemberIdentity_StoresMetaStealthAddress() public {
        _approveMember();

        vm.expectEmit();
        emit NetworkMemberRegistry.NetworkMemberIdentityRegistered(memberNetworkId, metaStealthAddress);
        vm.prank(networkMember.addr);
        registry.registerNetworkMemberIdentity(memberNetworkId, metaStealthAddress);

        assertEq(registry.identity(memberNetworkId), metaStealthAddress);
    }

    function test_RegisterNetworkMemberIdentity_AllowsGovernanceWrite() public {
        _approveMember();

        vm.prank(owner);
        registry.registerNetworkMemberIdentity(memberNetworkId, metaStealthAddress);

        assertEq(registry.identity(memberNetworkId), metaStealthAddress);
    }

    function test_RequestToJoin_RevertsWhen_CallerIsNotTheNetworkIdKey() public {
        vm.expectRevert(NetworkMemberRegistry.UnauthorizedCaller.selector);
        vm.prank(makeAddr("attacker"));
        registry.requestToJoin(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, ""
        );
    }

    function test_RequestToJoin_RevertsWhen_AlreadyApproved() public {
        _approveMember();

        vm.expectRevert(abi.encodeWithSelector(NetworkMemberRegistry.AlreadyApproved.selector, memberNetworkId));
        vm.prank(networkMember.addr);
        registry.requestToJoin(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, ""
        );
    }

    function test_RequestToJoin_RevertsWhen_CommitmentIsZero() public {
        vm.expectRevert(NetworkMemberRegistry.ZeroSemaphoreCommitment.selector);
        vm.prank(networkMember.addr);
        registry.requestToJoin(networkMember.publicKeyX, networkMember.publicKeyY, 0, governanceSigner, "");
    }

    function test_RequestToJoin_RevertsWhen_GovernanceSignerIsZero() public {
        vm.expectRevert(NetworkMemberRegistry.ZeroGovernanceSigner.selector);
        vm.prank(networkMember.addr);
        registry.requestToJoin(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, address(0), "");
    }

    function test_RequestToJoin_RevertsWhen_GovernanceSignerIsTheAuthAddress() public {
        // Safe ownership must not sit on the hot key that signs the member's routine record writes.
        vm.expectRevert(NetworkMemberRegistry.GovernanceSignerIsAuthAddress.selector);
        vm.prank(networkMember.addr);
        registry.requestToJoin(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, networkMember.addr, ""
        );
    }

    function test_RequestToJoin_AnnouncesTheRequestAndGrantsNothing() public {
        vm.expectEmit();
        emit NetworkMemberRegistry.NetworkMemberJoinRequested(
            memberNetworkId,
            networkMember.publicKeyX,
            networkMember.publicKeyY,
            semaphoreCommitment,
            governanceSigner,
            "<vetting material URL>"
        );
        vm.prank(networkMember.addr);
        registry.requestToJoin(
            networkMember.publicKeyX,
            networkMember.publicKeyY,
            semaphoreCommitment,
            governanceSigner,
            "<vetting material URL>"
        );

        assertFalse(registry.isApproved(memberNetworkId));
    }

    function test_ApproveNetworkMember_RecordsTheSemaphoreCommitment() public {
        _approveMember();

        assertEq(registry.semaphoreCommitmentOf(memberNetworkId), semaphoreCommitment);
    }

    function test_ApproveNetworkMember_RecordsTheGovernanceSigner() public {
        vm.expectEmit();
        emit NetworkMemberRegistry.GovernanceSignerPublished(memberNetworkId, governanceSigner);
        _approveMember();

        assertEq(registry.governanceSignerOf(memberNetworkId), governanceSigner);
    }

    /// @dev The Semaphore group refuses a zero leaf, so the record refuses one too: governance can
    /// write the registry directly, and the two must not be able to disagree.
    function test_ApproveNetworkMember_RevertsWhen_CommitmentIsZero() public {
        vm.expectRevert(NetworkMemberRegistry.ZeroSemaphoreCommitment.selector);
        vm.prank(owner);
        registry.approveNetworkMember(networkMember.publicKeyX, networkMember.publicKeyY, 0, governanceSigner);
    }

    function test_ApproveNetworkMember_RevertsWhen_GovernanceSignerIsZero() public {
        vm.expectRevert(NetworkMemberRegistry.ZeroGovernanceSigner.selector);
        vm.prank(owner);
        registry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, address(0)
        );
    }

    function test_ApproveNetworkMember_RevertsWhen_GovernanceSignerIsTheAuthAddress() public {
        vm.expectRevert(NetworkMemberRegistry.GovernanceSignerIsAuthAddress.selector);
        vm.prank(owner);
        registry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, networkMember.addr
        );
    }

    function test_RemoveNetworkMember_ClearsTheMemberRecord() public {
        _approveMember();

        _removeMember();

        assertEq(registry.semaphoreCommitmentOf(memberNetworkId), 0);
        assertEq(registry.governanceSignerOf(memberNetworkId), address(0));
    }

    function test_Constructor_RevertsWhen_GovernanceIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new NetworkMemberRegistry(address(0));
    }

    function test_TransferOwnership_MovesApprovalPowerToTheNewGovernance() public {
        address newGovernance = makeAddr("newGovernance");

        vm.prank(owner);
        registry.transferOwnership(newGovernance);
        // Ownable2Step: approval power only moves once the new governance accepts.
        assertEq(registry.owner(), owner);

        vm.prank(newGovernance);
        registry.acceptOwnership();

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, owner));
        vm.prank(owner);
        registry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner
        );

        vm.prank(newGovernance);
        registry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner
        );
        assertTrue(registry.isApproved(memberNetworkId));
    }
}
