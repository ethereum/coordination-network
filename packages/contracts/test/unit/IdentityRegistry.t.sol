// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { IdentityRegistry } from "../../src/IdentityRegistry.sol";
import { NetworkMemberGate } from "../../src/base/NetworkMemberGate.sol";
import { IdentityRegistryTestBase } from "../utils/IdentityRegistryTestBase.sol";

contract IdentityRegistryUnitTest is IdentityRegistryTestBase {
    function test_Identity_ReturnsEmptyForUnRegisteredNetworkId() public view {
        assertEq(identityRegistry.identity(keccak256("unknown")).length, 0);
    }

    function test_RegisterIdentity_StoresMetaStealthAddress() public {
        NetworkMemberGate.NetworkMemberProof memory proof = _proof("registerA");

        vm.expectEmit();
        emit IdentityRegistry.IdentityRegistered(networkIdA, metaA);
        identityRegistry.registerIdentity(networkIdA, metaA, proof);

        assertEq(identityRegistry.identity(networkIdA), metaA);
    }

    /// @dev The gating must hold for a stealth address or a paymaster-relayed sender, so no write
    /// path can be looking at msg.sender.
    function test_RegisterIdentity_AcceptedFromArbitrarySender() public {
        address stealthSender = makeAddr("stealth address nobody has seen before");

        vm.prank(stealthSender);
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        assertEq(identityRegistry.identity(networkIdA), metaA);
    }

    /// @dev The registry derives the message from the payload it is about to apply, so a proof for
    /// another update is not a proof at all: there is no message field for an attacker to line up.
    function test_RegisterIdentity_RevertsWhen_ProofIsForAnotherUpdate() public {
        // The proof authorises "register networkId A with meta A"; it is submitted with the
        // networkId B payload instead.
        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        identityRegistry.registerIdentity(networkIdB, metaB, _proof("registerA"));
    }

    function test_RegisterIdentity_RevertsWhen_MetaStealthAddressTampered() public {
        bytes memory tamperedMeta = metaA;
        tamperedMeta[1] = 0xff;

        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        identityRegistry.registerIdentity(networkIdA, tamperedMeta, _proof("registerA"));
    }

    /// @dev A register proof is not an update proof, even for the same networkId and payload.
    function test_UpdateIdentity_RevertsWhen_ProofIsForAnotherAction() public {
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        identityRegistry.updateIdentity(networkIdA, metaA, _proof("registerAByMemberOne"));
    }

    function test_RegisterIdentity_RevertsWhen_ProofIsResubmitted() public {
        NetworkMemberGate.NetworkMemberProof memory proof = _proof("registerA");
        identityRegistry.registerIdentity(networkIdA, metaA, proof);

        // Clear the row first, so nothing but the spent nullifier can stop the replay.
        identityRegistry.removeIdentity(networkIdA, _proof("removeA"));

        vm.expectRevert(ISemaphore.Semaphore__YouAreUsingTheSameNullifierTwice.selector);
        identityRegistry.registerIdentity(networkIdA, metaA, proof);
    }

    /// @dev A fresh scope gives a fresh nullifier, so a member can act as often as they need to and
    /// their updates do not link to each other.
    function test_RegisterIdentity_MemberActsAgainOnAFreshScope() public {
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        NetworkMemberGate.NetworkMemberProof memory first = _proof("registerA");
        NetworkMemberGate.NetworkMemberProof memory second = _proof("registerBAgain");
        assertTrue(second.nullifier != first.nullifier);

        identityRegistry.registerIdentity(networkIdB, metaB, second);

        assertEq(identityRegistry.identity(networkIdB), metaB);
    }

    function test_RegisterIdentity_RevertsWhen_ProofIsForged() public {
        NetworkMemberGate.NetworkMemberProof memory proof = _proof("registerA");
        proof.points[0] = proof.points[0] + 1;

        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        identityRegistry.registerIdentity(networkIdA, metaA, proof);
    }

    function test_RegisterIdentity_RevertsWhen_MetaStealthWrongLength() public {
        vm.expectRevert(IdentityRegistry.InvalidMetaStealthAddressLength.selector);
        identityRegistry.registerIdentity(networkIdA, new bytes(65), _proof("registerA"));
    }

    function test_RegisterIdentity_RevertsWhen_MetaStealthAddressTooLong() public {
        uint256 tooLongLength = identityRegistry.META_STEALTH_ADDRESS_LENGTH() + 1;
        bytes memory tooLongMeta = new bytes(tooLongLength);
        NetworkMemberGate.NetworkMemberProof memory proof = _proof("registerA");

        vm.expectRevert(IdentityRegistry.InvalidMetaStealthAddressLength.selector);
        identityRegistry.registerIdentity(networkIdA, tooLongMeta, proof);
    }

    function test_RegisterIdentity_RegistersANetworkIdAgainAfterRemoval() public {
        NetworkMemberGate.NetworkMemberProof memory registerProof = _proof("registerA");
        NetworkMemberGate.NetworkMemberProof memory removeProof = _proof("removeA");
        NetworkMemberGate.NetworkMemberProof memory secondMemberRegisterProof = _proof("registerAByMemberOne");
        identityRegistry.registerIdentity(networkIdA, metaA, registerProof);
        identityRegistry.removeIdentity(networkIdA, removeProof);

        identityRegistry.registerIdentity(networkIdA, metaA, secondMemberRegisterProof);

        bytes memory registeredMeta = identityRegistry.identity(networkIdA);
        assertEq(registeredMeta, metaA);
    }

    function test_RegisterIdentity_RevertsWhen_AlreadyRegistered() public {
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.AlreadyRegistered.selector, networkIdA));
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerAByMemberOne"));
    }

    function test_UpdateIdentity_RepointsNetworkId() public {
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        vm.expectEmit();
        emit IdentityRegistry.IdentityUpdated(networkIdA, metaB);
        identityRegistry.updateIdentity(networkIdA, metaB, _proof("updateA"));

        assertEq(identityRegistry.identity(networkIdA), metaB);
    }

    function test_UpdateIdentity_RevertsWhen_NotRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.NotRegistered.selector, networkIdA));
        identityRegistry.updateIdentity(networkIdA, metaB, _proof("updateA"));
    }

    function test_UpdateIdentity_RevertsWhen_MetaStealthWrongLength() public {
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        vm.expectRevert(IdentityRegistry.InvalidMetaStealthAddressLength.selector);
        identityRegistry.updateIdentity(networkIdA, new bytes(65), _proof("updateA"));
    }

    function test_RemoveIdentity_ClearsNetworkId() public {
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        vm.expectEmit();
        emit IdentityRegistry.IdentityRemoved(networkIdA);
        identityRegistry.removeIdentity(networkIdA, _proof("removeA"));

        assertEq(identityRegistry.identity(networkIdA).length, 0);
    }

    function test_RemoveIdentity_RevertsWhen_ProofIsForAnotherAction() public {
        NetworkMemberGate.NetworkMemberProof memory registerProof = _proof("registerA");
        NetworkMemberGate.NetworkMemberProof memory updateProof = _proof("updateA");
        identityRegistry.registerIdentity(networkIdA, metaA, registerProof);

        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        identityRegistry.removeIdentity(networkIdA, updateProof);
    }

    function test_RemoveIdentity_RevertsWhen_NotRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(IdentityRegistry.NotRegistered.selector, networkIdA));
        identityRegistry.removeIdentity(networkIdA, _proof("removeA"));
    }
}
