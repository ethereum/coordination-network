// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { PoseidonT3 } from "poseidon-solidity/PoseidonT3.sol";
import { IIssuerRegistries } from "../../src/issuer-registry/interfaces/IIssuerRegistries.sol";
import { IssuerRegistryTestBase } from "../utils/IssuerRegistryTestBase.sol";

/// @dev Covers the registry-and-tree half of the service: admin gating, the four mutations, and the
/// read surface a holder rebuilds the tree from.
contract IssuerRegistriesTest is IssuerRegistryTestBase {
    uint256 internal constant A = 100;
    uint256 internal constant B = 200;
    uint256 internal constant C = 300;
    uint256 internal constant D = 400;

    function test_createRegistry_setsTheCallerAsAdmin() public view {
        assertEq(issuerRegistry.getRegistryAdmin(registryId), admin);
        assertEq(issuerRegistry.getIssuerRoot(registryId), 0);
        assertEq(issuerRegistry.getIssuerTreeSize(registryId), 0);
        assertEq(issuerRegistry.getIssuerTreeDepth(registryId), 0);
    }

    function test_createRegistry_rejectsTheZeroAdmin() public {
        vm.expectRevert(IIssuerRegistries.ZeroAdmin.selector);
        issuerRegistry.createRegistry(address(0));
    }

    function test_addIssuer_recordsTheCommitmentAndMovesTheRoot() public {
        vm.expectEmit(true, false, false, true);
        emit IIssuerRegistries.IssuerAdded(registryId, 0, A, A);

        add(registryId, A);

        assertTrue(issuerRegistry.isIssuer(registryId, A));
        assertFalse(issuerRegistry.isIssuer(registryId, B));
        assertEq(issuerRegistry.indexOf(registryId, A), 0);
        assertEq(issuerRegistry.getLeaf(registryId, 0), A);
        assertEq(issuerRegistry.getIssuerTreeSize(registryId), 1);
        // A one-leaf LeanIMT's root is the leaf itself.
        assertEq(issuerRegistry.getIssuerRoot(registryId), A);
    }

    function test_addIssuer_emitsTheIndexAndTheNewRoot() public {
        add(registryId, A);
        uint256 expectedRoot = hashNodes(A, B);

        vm.expectEmit(true, false, false, true);
        emit IIssuerRegistries.IssuerAdded(registryId, 1, B, expectedRoot);

        add(registryId, B);
    }

    function test_addIssuer_isOnlyForTheRegistryAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IIssuerRegistries.CallerIsNotTheRegistryAdmin.selector);
        issuerRegistry.addIssuer(registryId, A);
    }

    function test_addIssuer_rejectsZero() public {
        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.addIssuer(registryId, 0);
    }

    function test_addIssuer_rejectsADuplicate() public {
        add(registryId, A);

        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.addIssuer(registryId, A);
    }

    function test_addIssuer_rejectsAValueAboveTheRange() public virtual {
        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.addIssuer(registryId, maxCommitment() + 1);
    }

    function test_addIssuer_acceptsTheLargestValue() public {
        add(registryId, maxCommitment());

        assertTrue(issuerRegistry.isIssuer(registryId, maxCommitment()));
    }

    function test_getIssuerTreeDepth_tracksTheLeafCount() public {
        add(registryId, A);
        assertEq(issuerRegistry.getIssuerTreeDepth(registryId), 0);

        add(registryId, B);
        assertEq(issuerRegistry.getIssuerTreeDepth(registryId), 1);

        add(registryId, C);
        assertEq(issuerRegistry.getIssuerTreeDepth(registryId), 2);
    }

    function test_addIssuers_matchesAddingOneByOne() public {
        uint256 batched = issuerRegistry.createRegistry(admin);

        uint256[] memory commitments = new uint256[](3);
        commitments[0] = C;
        commitments[1] = A;
        commitments[2] = B;

        vm.expectEmit(true, false, false, false);
        emit IIssuerRegistries.IssuersAdded(batched, 0, commitments, 0);

        vm.prank(admin);
        issuerRegistry.addIssuers(batched, commitments);

        add(registryId, C);
        add(registryId, A);
        add(registryId, B);

        assertEq(issuerRegistry.getIssuerRoot(batched), issuerRegistry.getIssuerRoot(registryId));
        assertEq(issuerRegistry.getIssuerTreeSize(batched), 3);

        for (uint256 i = 0; i < commitments.length; ++i) {
            assertEq(issuerRegistry.getLeaf(batched, i), commitments[i]);
        }
    }

    function test_addIssuers_appendsAfterExistingLeaves() public {
        add(registryId, A);

        uint256[] memory commitments = new uint256[](2);
        commitments[0] = B;
        commitments[1] = C;

        vm.expectEmit(true, false, false, false);
        emit IIssuerRegistries.IssuersAdded(registryId, 1, commitments, 0);

        vm.prank(admin);
        issuerRegistry.addIssuers(registryId, commitments);

        assertEq(issuerRegistry.indexOf(registryId, C), 2);
        assertEq(issuerRegistry.getIssuerRoot(registryId), rebuiltRoot(registryId));
    }

    function test_addIssuers_rejectsAnEmptyBatch() public {
        vm.prank(admin);
        vm.expectRevert(IIssuerRegistries.NoIssuerCommitments.selector);
        issuerRegistry.addIssuers(registryId, new uint256[](0));
    }

    function test_addIssuers_rejectsADuplicateInTheBatch() public {
        uint256[] memory commitments = new uint256[](2);
        commitments[0] = A;
        commitments[1] = A;

        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.addIssuers(registryId, commitments);
    }

    function test_addIssuers_isOnlyForTheRegistryAdmin() public {
        uint256[] memory commitments = new uint256[](1);
        commitments[0] = A;

        vm.prank(stranger);
        vm.expectRevert(IIssuerRegistries.CallerIsNotTheRegistryAdmin.selector);
        issuerRegistry.addIssuers(registryId, commitments);
    }

    function test_removeIssuer_zeroesTheLeafAndKeepsItsSlot() public {
        add(registryId, A);
        add(registryId, B);
        add(registryId, C);

        uint256[] memory siblings = siblingNodes(registryId, B);

        vm.prank(admin);
        issuerRegistry.removeIssuer(registryId, B, siblings);

        assertFalse(issuerRegistry.isIssuer(registryId, B));
        assertEq(issuerRegistry.getLeaf(registryId, 1), 0);
        assertEq(issuerRegistry.getIssuerTreeSize(registryId), 3);
        assertEq(issuerRegistry.indexOf(registryId, C), 2);
        assertEq(issuerRegistry.getIssuerRoot(registryId), hashNodes(hashNodes(A, 0), C));
        assertEq(issuerRegistry.getIssuerRoot(registryId), rebuiltRoot(registryId));
    }

    function test_removeIssuer_emitsTheIndexAndTheNewRoot() public {
        add(registryId, A);
        add(registryId, B);

        uint256[] memory siblings = siblingNodes(registryId, A);
        uint256 expectedRoot = hashNodes(0, B);

        vm.expectEmit(true, false, false, true);
        emit IIssuerRegistries.IssuerRemoved(registryId, 0, A, expectedRoot);

        vm.prank(admin);
        issuerRegistry.removeIssuer(registryId, A, siblings);
    }

    function test_removeIssuer_canEmptyAOneLeafRegistry() public {
        add(registryId, A);
        remove(registryId, A);

        assertEq(issuerRegistry.getIssuerRoot(registryId), 0);
        assertEq(issuerRegistry.getIssuerTreeSize(registryId), 1);
    }

    function test_removeIssuer_rejectsWrongSiblings() public {
        add(registryId, A);
        add(registryId, B);
        add(registryId, C);

        uint256[] memory siblings = siblingNodes(registryId, B);
        siblings[0] = D;

        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.removeIssuer(registryId, B, siblings);
    }

    function test_removeIssuer_rejectsACommitmentThatIsNotAnIssuer() public {
        add(registryId, A);

        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.removeIssuer(registryId, B, new uint256[](0));
    }

    function test_removeIssuer_rejectsZero() public {
        add(registryId, A);
        add(registryId, B);
        remove(registryId, A);

        uint256[] memory siblings = new uint256[](1);
        siblings[0] = B;

        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.removeIssuer(registryId, 0, siblings);
    }

    function test_removeIssuer_isOnlyForTheRegistryAdmin() public {
        add(registryId, A);

        vm.prank(stranger);
        vm.expectRevert(IIssuerRegistries.CallerIsNotTheRegistryAdmin.selector);
        issuerRegistry.removeIssuer(registryId, A, new uint256[](0));
    }

    function test_aRemovedIssuerCanBeAddedAgainInANewSlot() public {
        add(registryId, A);
        add(registryId, B);
        remove(registryId, A);

        add(registryId, A);

        assertTrue(issuerRegistry.isIssuer(registryId, A));
        assertEq(issuerRegistry.indexOf(registryId, A), 2);
        assertEq(issuerRegistry.getLeaf(registryId, 0), 0);
        assertEq(issuerRegistry.getIssuerRoot(registryId), rebuiltRoot(registryId));
    }

    function test_updateIssuerCommitment_reusesTheSlot() public {
        add(registryId, A);
        add(registryId, B);
        add(registryId, C);

        uint256[] memory siblings = siblingNodes(registryId, B);

        vm.expectEmit(true, false, false, false);
        emit IIssuerRegistries.IssuerCommitmentUpdated(registryId, 1, B, D, 0);

        vm.prank(admin);
        issuerRegistry.updateIssuerCommitment(registryId, B, D, siblings);

        assertFalse(issuerRegistry.isIssuer(registryId, B));
        assertTrue(issuerRegistry.isIssuer(registryId, D));
        assertEq(issuerRegistry.indexOf(registryId, D), 1);
        assertEq(issuerRegistry.getLeaf(registryId, 1), D);
        assertEq(issuerRegistry.getIssuerTreeSize(registryId), 3);
        assertEq(issuerRegistry.getIssuerRoot(registryId), rebuiltRoot(registryId));
    }

    function test_updateIssuerCommitment_rejectsZero() public {
        add(registryId, A);

        vm.prank(admin);
        vm.expectRevert(IIssuerRegistries.IssuerCommitmentCannotBeZero.selector);
        issuerRegistry.updateIssuerCommitment(registryId, A, 0, new uint256[](0));
    }

    function test_updateIssuerCommitment_rejectsAnExistingIssuer() public {
        add(registryId, A);
        add(registryId, B);

        uint256[] memory siblings = siblingNodes(registryId, A);

        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.updateIssuerCommitment(registryId, A, B, siblings);
    }

    function test_updateIssuerCommitment_rejectsWrongSiblings() public {
        add(registryId, A);
        add(registryId, B);

        uint256[] memory siblings = new uint256[](1);
        siblings[0] = C;

        vm.prank(admin);
        vm.expectRevert();
        issuerRegistry.updateIssuerCommitment(registryId, A, D, siblings);
    }

    function test_updateIssuerCommitment_isOnlyForTheRegistryAdmin() public {
        add(registryId, A);

        vm.prank(stranger);
        vm.expectRevert(IIssuerRegistries.CallerIsNotTheRegistryAdmin.selector);
        issuerRegistry.updateIssuerCommitment(registryId, A, B, new uint256[](0));
    }

    function test_indexOf_revertsForACommitmentThatIsNotAnIssuer() public {
        add(registryId, A);

        vm.expectRevert();
        issuerRegistry.indexOf(registryId, B);
    }

    function test_getLeaf_revertsPastTheLastLeaf() public {
        add(registryId, A);

        vm.expectRevert();
        issuerRegistry.getLeaf(registryId, 1);
    }

    function test_adminTransfer_takesTwoSteps() public {
        vm.prank(admin);
        issuerRegistry.updateRegistryAdmin(registryId, stranger);

        assertEq(issuerRegistry.getRegistryAdmin(registryId), admin);
        assertEq(issuerRegistry.getPendingRegistryAdmin(registryId), stranger);

        vm.prank(stranger);
        issuerRegistry.acceptRegistryAdmin(registryId);

        assertEq(issuerRegistry.getRegistryAdmin(registryId), stranger);
        assertEq(issuerRegistry.getPendingRegistryAdmin(registryId), address(0));
    }

    function test_adminTransfer_isOnlyProposableByTheAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(IIssuerRegistries.CallerIsNotTheRegistryAdmin.selector);
        issuerRegistry.updateRegistryAdmin(registryId, stranger);
    }

    function test_adminTransfer_isOnlyAcceptableByThePendingAdmin() public {
        vm.prank(admin);
        issuerRegistry.updateRegistryAdmin(registryId, stranger);

        vm.expectRevert(IIssuerRegistries.CallerIsNotThePendingRegistryAdmin.selector);
        issuerRegistry.acceptRegistryAdmin(registryId);
    }

    /// @dev Pins the node hash, so a rebuilt off-chain tree reproduces the contract's root. The roots
    /// themselves are compared across languages in test/integration/IssuerRegistryCrossLanguageRoot.t.sol.
    function test_theRootHashesTheLeavesWithTheSchemeNodeHash() public virtual {
        add(registryId, A);
        add(registryId, B);
        add(registryId, C);

        assertEq(issuerRegistry.getIssuerRoot(registryId), PoseidonT3.hash([PoseidonT3.hash([A, B]), C]));
    }
}
