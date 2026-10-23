// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IRevocation } from "../../src/revocation/interfaces/IRevocation.sol";
import { IRevocationRegistries } from "../../src/revocation/interfaces/IRevocationRegistries.sol";
import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import { stdJson } from "forge-std/StdJson.sol";

import { CredentialRevocationRegistry } from "../../src/CredentialRevocationRegistry.sol";
import { NetworkMemberGate } from "../../src/base/NetworkMemberGate.sol";
import { CredentialRevocationRegistryTestBase } from "../utils/CredentialRevocationRegistryTestBase.sol";

contract CredentialRevocationRegistryUnitTest is CredentialRevocationRegistryTestBase {
    using stdJson for string;

    address stranger = makeAddr("stranger");

    function test_Constructor_PointsAtTheGroupAndTheService() public view {
        assertEq(address(revocationRegistry.SEMAPHORE()), address(semaphore));
        assertEq(revocationRegistry.NETWORK_MEMBER_GROUP_ID(), networkMemberGroupId);
        assertEq(address(revocationRegistry.REVOCATION()), address(revocation));
    }

    /// @dev The registry's admin is this contract, so a gated function is the only way into the tree
    /// and the service never learns which member wrote.
    function test_Constructor_AdminsItsOwnRegistryOnTheService() public view {
        assertEq(revocation.getRegistryAdmin(_registryId()), address(revocationRegistry));
    }

    /// @dev The service refuses a write that skipped the gate, so the anonymous proof
    /// is the only way into the tree.
    function test_RevocationService_RevertsWhen_WriteSkipsTheGate() public {
        uint256 registryId = _registryId();

        vm.prank(stranger);
        vm.expectRevert(IRevocationRegistries.CallerIsNotTheRegistryAdmin.selector);
        revocation.revoke(registryId, commitmentA, 0);
    }

    function test_Constructor_StartsWithAnEmptyTree() public view {
        assertEq(revocation.getRevocationTreeLeafCount(_registryId()), 0);
        assertEq(revocationRegistry.getRevocationRoot(), 0);
    }

    function test_Constructor_RevertsWhen_NoRevocationService() public {
        vm.expectRevert(CredentialRevocationRegistry.ZeroRevocationService.selector);
        new CredentialRevocationRegistry(ISemaphore(address(semaphore)), networkMemberGroupId, IRevocation(address(0)));
    }

    /// @dev The other tests prove client and contract agree end to end; this pins it legibly.
    function test_RevocationDomainSeparator_MatchesTheClientDerivation() public view {
        assertEq(revocationRegistry.REVOCATION_DOMAIN_SEPARATOR(), fixtures.readBytes32(".revocationDomainSeparator"));
    }

    function test_Revoke_InsertsTheCommitmentAndMovesTheRoot() public {
        revocationRegistry.revoke(commitmentA, _lowLeafIndex(commitmentA), _proof("revokeA"));

        assertTrue(revocation.isRevoked(_registryId(), commitmentA));
        assertTrue(revocationRegistry.getRevocationRoot() != 0);
        assertTrue(revocationRegistry.isValidRoot(revocationRegistry.getRevocationRoot()));
    }

    /// @dev The proof is the authority, not the sender, so a member can submit from a fresh stealth
    /// address with a paymaster covering the gas.
    function test_Revoke_AcceptsAnyoneAsTheSubmitter() public {
        vm.prank(stranger);
        revocationRegistry.revoke(commitmentA, _lowLeafIndex(commitmentA), _proof("revokeA"));

        assertTrue(revocation.isRevoked(_registryId(), commitmentA));
    }

    /// @dev The registry derives the message from the arguments it applies, so a proof aimed
    /// elsewhere fails verification rather than a comparison.
    function test_Revoke_RevertsWhen_ProofIsForAnotherCommitment() public {
        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        revocationRegistry.revoke(commitmentB, 0, _proof("revokeA"));
    }

    function test_Revoke_RevertsWhen_ProofIsReplayed() public {
        revocationRegistry.revoke(commitmentA, _lowLeafIndex(commitmentA), _proof("revokeA"));

        vm.expectRevert(ISemaphore.Semaphore__YouAreUsingTheSameNullifierTwice.selector);
        revocationRegistry.revoke(commitmentA, 0, _proof("revokeA"));
    }

    function test_Revoke_RevertsWhen_ProofIsFromAForeignGroup() public {
        vm.expectRevert(ISemaphore.Semaphore__MerkleTreeRootIsNotPartOfTheGroup.selector);
        revocationRegistry.revoke(commitmentA, 0, _proof("foreignGroupRevokeA"));
    }

    /// @dev A removed member keeps writing until its proof's root leaves the recent-root window.
    function test_Revoke_RevertsWhen_RemovedMembersRootExpired() public {
        _removeNetworkMemberCommitment(2);

        vm.warp(block.timestamp + MERKLE_TREE_DURATION);

        vm.expectRevert(ISemaphore.Semaphore__MerkleTreeRootIsExpired.selector);
        revocationRegistry.revoke(commitmentB, 0, _proof("removedMemberRevokeB"));
    }

    /// @dev Any approved member can revoke any credential, unattributably. The accepted residual
    /// risk, pinned so a change to it is deliberate.
    function test_Revoke_AcceptsAnyApprovedMemberForTheSameCommitment() public {
        revocationRegistry.revoke(commitmentA, _lowLeafIndex(commitmentA), _proof("revokeAByMemberOne"));

        assertTrue(revocation.isRevoked(_registryId(), commitmentA));
    }

    function test_RevokeMany_RevokesTheBatch() public {
        // A goes first, so its index is ignored: that insert creates the sentinel at slot 0 and puts
        // A at slot 1, making A the low leaf of B. Batch indices describe the state the earlier
        // commitments leave behind, which is why they cannot be looked up on chain.
        revocationRegistry.revokeMany(_two(commitmentA, commitmentB), _two(0, 1), _proof("revokeManyAB"));

        assertTrue(revocation.isRevoked(_registryId(), commitmentA));
        assertTrue(revocation.isRevoked(_registryId(), commitmentB));
    }

    /// @dev A one-commitment batch packs like a single revocation, so only the action keeps a
    /// {revoke} proof from authorising a {revokeMany}.
    function test_RevokeMany_RevertsWhen_ProofIsForASingleRevocation() public {
        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        revocationRegistry.revokeMany(_one(commitmentA), _one(0), _proof("revokeA"));
    }

    /// @dev Every action is a distinct message, so a proof authorising a revocation cannot be
    /// turned around into the un-revocation that undoes it.
    function test_Unrevoke_RevertsWhen_ProofIsForAnotherAction() public {
        vm.expectRevert(ISemaphore.Semaphore__InvalidProof.selector);
        revocationRegistry.unrevoke(commitmentA, 0, _proof("revokeA"));
    }

    function test_Unrevoke_RestoresTheCredential() public {
        revocationRegistry.revoke(commitmentA, _lowLeafIndex(commitmentA), _proof("revokeA"));

        revocationRegistry.unrevoke(commitmentA, _predecessorIndex(commitmentA), _proof("unrevokeA"));

        assertFalse(revocation.isRevoked(_registryId(), commitmentA));
    }

    function test_UpdateRevocationCommitment_ReplacesInPlace() public {
        revocationRegistry.revoke(commitmentA, _lowLeafIndex(commitmentA), _proof("revokeA"));

        revocationRegistry.updateRevocationCommitment(
            commitmentA, commitmentC, _predecessorIndex(commitmentA), 0, _proof("replaceAWithC")
        );

        assertFalse(revocation.isRevoked(_registryId(), commitmentA));
        assertTrue(revocation.isRevoked(_registryId(), commitmentC));
    }

    /// @dev The circuit canonicalises an empty-registry witness to a zero root, so presentations
    /// verify from the first block.
    function test_IsValidRoot_AcceptsZeroWhileTheTreeIsEmpty() public view {
        assertTrue(revocationRegistry.isValidRoot(0));
    }

    function test_IsValidRoot_RejectsAnUnknownRoot() public view {
        assertFalse(revocationRegistry.isValidRoot(12_345));
    }

    /// @dev A proof built against the root a revocation just replaced still verifies for the
    /// registry's window.
    function test_IsValidRoot_AcceptsASupersededRootInsideTheWindow() public {
        revocationRegistry.revoke(commitmentA, _lowLeafIndex(commitmentA), _proof("revokeA"));
        uint256 supersededRoot = revocationRegistry.getRevocationRoot();

        revocationRegistry.revoke(commitmentB, _lowLeafIndex(commitmentB), _proof("revokeB"));

        assertTrue(revocationRegistry.getRevocationRoot() != supersededRoot);
        assertTrue(revocationRegistry.isValidRoot(supersededRoot));

        vm.warp(block.timestamp + ROOT_DURATION);

        assertFalse(revocationRegistry.isValidRoot(supersededRoot));
    }

    /// @dev Empty-tree proofs get the same grace window as proofs against later roots.
    function test_IsValidRoot_EmptyRootGetsTheGraceWindow() public {
        revocationRegistry.revoke(commitmentA, _lowLeafIndex(commitmentA), _proof("revokeA"));

        assertTrue(revocationRegistry.isValidRoot(0));

        vm.warp(block.timestamp + ROOT_DURATION - 1);
        assertTrue(revocationRegistry.isValidRoot(0));

        vm.warp(block.timestamp + 1);
        assertFalse(revocationRegistry.isValidRoot(0));
    }
}
