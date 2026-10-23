// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Enum } from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";
import { OwnerManager } from "@safe-global/safe-smart-account/contracts/base/OwnerManager.sol";

import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { NetworkMemberGovernance } from "../../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { ISafeGovernance } from "../../src/interfaces/ISafeGovernance.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

/// @dev The governance gate end to end, against a real Safe: a permissionless join request, then
/// admission by a majority of the current members in one call that also makes the new member an
/// approver, then removal.
contract NetworkMemberGovernanceIntegrationTest is NetworkMemberRegistryTestBase {
    uint256 internal constant FOUNDING_MEMBERS = 5;

    NetworkMemberRegistry internal governedRegistry;
    NetworkMemberGroup internal governedGroup;
    NetworkMemberGovernance internal governance;

    function _setUpSafeGovernedContracts() internal {
        _deployGovernanceSafe(FOUNDING_MEMBERS);
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

    /// @dev The one call a quorum signs to admit a member.
    function _admissionCall(uint256 accountKeyX, uint256 accountKeyY, uint256 commitment, address signer)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodeCall(
            NetworkMemberGovernance.admitMember, (accountKeyX, accountKeyY, commitment, signer, safe.getOwners().length)
        );
    }

    /// @dev The quorum the Safe currently requires.
    function _quorum() internal view returns (uint256) {
        return safe.getThreshold();
    }

    function _admitMember(uint256 accountKeyX, uint256 accountKeyY, uint256 commitment, address signer) internal {
        _execFromSafe(address(governance), _admissionCall(accountKeyX, accountKeyY, commitment, signer), _quorum());
    }

    function test_Governance_ThresholdIsAMajorityOfTheMembers() public {
        _setUpSafeGovernedContracts();

        // Five founding members, so three signatures.
        assertEq(safe.getOwners().length, FOUNDING_MEMBERS);
        assertEq(safe.getThreshold(), 3);
    }

    function test_Governance_SafeIsTheSoleWriterOfBothContracts() public {
        _setUpSafeGovernedContracts();

        assertEq(governedRegistry.owner(), address(safe));
        assertEq(governedGroup.owner(), address(safe));

        // No individual member can admit a member on its own, in either contract.
        address singleSigner = safe.getOwners()[0];
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, singleSigner));
        vm.prank(singleSigner);
        governedRegistry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner
        );

        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, singleSigner));
        vm.prank(singleSigner);
        governedGroup.addNetworkMember(semaphoreCommitment);
    }

    function test_Governance_JoinRequestIsPermissionlessAndAdmissionNeedsAMajority() public {
        _setUpSafeGovernedContracts();

        // 1. The prospective member announces itself, publishing the governance signer it wants added
        // to the Safe. Nobody gatekeeps this call, and it grants nothing.
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
        governedRegistry.requestToJoin(
            networkMember.publicKeyX,
            networkMember.publicKeyY,
            semaphoreCommitment,
            governanceSigner,
            "<vetting material URL>"
        );
        assertFalse(governedRegistry.isApproved(memberNetworkId));
        assertFalse(safe.isOwner(governanceSigner));

        // 2. Two of the five members is not a majority: the Safe itself rejects the signature set,
        // GS020 being its "signatures data too short" error.
        bytes memory admission =
            _admissionCall(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);
        bytes memory tooFewSignatures = _signForSafe(address(governance), admission, Enum.Operation.Call, _quorum() - 1);

        vm.expectRevert(bytes("GS020"));
        _execSignedFromSafe(address(governance), admission, Enum.Operation.Call, tooFewSignatures);
        assertFalse(governedRegistry.isApproved(memberNetworkId));

        // 3. Three of the five is.
        _admitMember(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);

        assertTrue(governedRegistry.isApproved(memberNetworkId));
        assertEq(governedRegistry.semaphoreCommitmentOf(memberNetworkId), semaphoreCommitment);
        assertEq(governedRegistry.governanceSignerOf(memberNetworkId), governanceSigner);
        assertTrue(governedGroup.hasNetworkMember(semaphoreCommitment));
    }

    function test_Governance_AdmissionMakesTheNewMemberAnApprover() public {
        _setUpSafeGovernedContracts();

        _admitMember(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);

        // Six members now, so four signatures: the owner set and the threshold moved together.
        assertTrue(safe.isOwner(governanceSigner));
        assertEq(safe.getOwners().length, 6);
        assertEq(safe.getThreshold(), 4);
    }

    function test_Governance_NewApproverCanVoteOnTheNextCandidate() public {
        _setUpSafeGovernedContracts();
        _admitMember(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);

        // The new member's governance key is now one of the owners the next admission can draw on.
        // Signing with the last four owners, which includes the freshly added one, admits the next
        // candidate: the founding members alone are no longer the only possible quorum.
        Vm.Wallet memory secondMember = vm.createWallet("secondMember");
        bytes32 secondNetworkId = keccak256(abi.encodePacked(secondMember.publicKeyX, secondMember.publicKeyY));
        uint256 secondCommitment = _semaphoreCommitment("secondMember");
        address secondSigner = makeAddr("secondGovernanceSigner");

        _execFromSafeWithLastSigners(
            address(governance),
            _admissionCall(secondMember.publicKeyX, secondMember.publicKeyY, secondCommitment, secondSigner),
            safe.getThreshold()
        );

        assertTrue(governedRegistry.isApproved(secondNetworkId));
        assertTrue(safe.isOwner(secondSigner));
        // Seven members, so still four signatures.
        assertEq(safe.getOwners().length, 7);
        assertEq(safe.getThreshold(), 4);
    }

    function test_Governance_RemovalTakesTheMemberOutOfAllThreePlaces() public {
        _setUpSafeGovernedContracts();
        _admitMember(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);

        // A one-leaf group has depth zero, so the membership proof is empty. The commitment, the
        // signer and the new threshold are all read or computed on chain.
        _execFromSafe(
            address(governance),
            abi.encodeCall(
                NetworkMemberGovernance.removeMember, (memberNetworkId, new uint256[](0), safe.getOwners().length)
            ),
            _quorum()
        );

        assertFalse(governedRegistry.isApproved(memberNetworkId));
        assertFalse(governedGroup.hasNetworkMember(semaphoreCommitment));
        assertFalse(safe.isOwner(governanceSigner));
        // Back to five members, so back to three signatures.
        assertEq(safe.getOwners().length, 5);
        assertEq(safe.getThreshold(), 3);
    }

    function test_Governance_SignaturesDoNotCarryToAnotherTransaction() public {
        _setUpSafeGovernedContracts();

        bytes memory approval = abi.encodeCall(
            NetworkMemberRegistry.approveNetworkMember,
            (networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner)
        );
        bytes memory signatures = _signForSafe(address(governedRegistry), approval, _quorum());

        Vm.Wallet memory otherKey = vm.createWallet("other");
        bytes memory otherApproval = abi.encodeCall(
            NetworkMemberRegistry.approveNetworkMember,
            (otherKey.publicKeyX, otherKey.publicKeyY, _semaphoreCommitment("other"), governanceSigner)
        );

        // GS026 is the Safe's "invalid owner provided": the signatures recover to nobody it knows,
        // because they were made over a different transaction.
        vm.expectRevert(bytes("GS026"));
        _execSignedFromSafe(address(governedRegistry), otherApproval, Enum.Operation.Call, signatures);
    }

    /// @dev A Safe evaluates a quorum at execution, and normally relies on its nonce advancing to
    /// invalidate transactions signed against an older owner set. A module call does not advance the
    /// nonce, so a voluntary exit shrinks the member set and the threshold with it while signature sets
    /// are in flight. Without the pinned member count, three signatures the Safe had just rejected as
    /// short of a quorum of four would execute the moment a departure made three a majority.
    function test_Governance_ExitInvalidatesSignaturesCollectedAgainstTheOldMemberSet() public {
        _setUpSafeGovernedContracts();
        _admitMember(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);
        assertEq(safe.getThreshold(), 4);
        uint256 nonceBeforeExit = safe.nonce();

        // Three signatures for a second admission, one short of the quorum of four.
        Vm.Wallet memory secondMember = vm.createWallet("second");
        bytes memory second = _admissionCall(
            secondMember.publicKeyX, secondMember.publicKeyY, _semaphoreCommitment("second"), makeAddr("secondSigner")
        );
        bytes memory threeSignatures = _signForSafe(address(governance), second, Enum.Operation.Call, 3);

        vm.expectRevert(bytes("GS020"));
        _execSignedFromSafe(address(governance), second, Enum.Operation.Call, threeSignatures);

        // The admitted member leaves: five members, threshold three, and the nonce never moved, so the
        // signature set is still nominally valid for the Safe.
        vm.prank(governanceSigner);
        governance.exitNetwork(memberNetworkId, new uint256[](0));
        assertEq(safe.getThreshold(), 3);
        assertEq(safe.nonce(), nonceBeforeExit);

        // The Safe now accepts the three signatures, and the pinned member count stops the operation.
        // Safe 1.5.0 bubbles the inner revert, so the reason survives all the way out.
        vm.expectRevert(abi.encodeWithSelector(NetworkMemberGovernance.MemberCountChanged.selector, 6, 5));
        _execSignedFromSafe(address(governance), second, Enum.Operation.Call, threeSignatures);
        assertFalse(
            governedRegistry.isApproved(keccak256(abi.encodePacked(secondMember.publicKeyX, secondMember.publicKeyY)))
        );
    }

    /// @dev The approval path the runbook documents, and the only one: nothing is circulated, and no
    /// approver ever acts on a payload another party assembled. Each derives the transaction itself,
    /// records its approval in the Safe's storage, and the member that completes the quorum executes.
    function test_Governance_AdmissionByOnChainApprovalsWithNothingCirculated() public {
        _setUpSafeGovernedContracts();

        bytes memory admission =
            _admissionCall(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);
        bytes32 txHash = _safeTransactionHash(address(governance), admission);

        // Two of the five members approve, each from its own key, in its own transaction.
        _approveHashAsOwner(0, txHash);
        _approveHashAsOwner(1, txHash);
        assertEq(safe.approvedHashes(safeSigners[0].addr, txHash), 1);
        assertEq(safe.approvedHashes(safeSigners[1].addr, txHash), 1);
        assertFalse(governedRegistry.isApproved(memberNetworkId));

        // The third names those two plus itself and submits. Its own slot needs no prior approval,
        // because the Safe counts the executor as having approved.
        uint256[] memory indices = new uint256[](3);
        indices[0] = 0;
        indices[1] = 1;
        indices[2] = 2;

        vm.prank(safeSigners[2].addr);
        _execSignedFromSafe(address(governance), admission, Enum.Operation.Call, _onChainApprovals(indices));

        assertTrue(governedRegistry.isApproved(memberNetworkId));
        assertTrue(governedGroup.hasNetworkMember(semaphoreCommitment));
        assertTrue(safe.isOwner(governanceSigner));
        assertEq(safe.getThreshold(), 4);
    }

    /// @dev The executor exemption reaches exactly one slot. An owner that neither approved on chain nor
    /// sent the transaction cannot be counted, so a quorum cannot be padded with bystanders.
    function test_Governance_OnChainApprovalRevertsWhen_ASlotIsNeitherApprovedNorTheExecutor() public {
        _setUpSafeGovernedContracts();

        bytes memory admission =
            _admissionCall(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);
        bytes32 txHash = _safeTransactionHash(address(governance), admission);

        // Only one member approves. The executor makes two; the third slot is an owner that did nothing.
        _approveHashAsOwner(0, txHash);

        uint256[] memory indices = new uint256[](3);
        indices[0] = 0;
        indices[1] = 2;
        indices[2] = 3;

        // GS025 is the Safe's "hash has not been approved" for that slot.
        vm.expectRevert(bytes("GS025"));
        vm.prank(safeSigners[2].addr);
        _execSignedFromSafe(address(governance), admission, Enum.Operation.Call, _onChainApprovals(indices));

        assertFalse(governedRegistry.isApproved(memberNetworkId));
    }

    /// @dev What the orchestrator does not fix: the chain still does not police what a quorum signs.
    /// Routing the admission through {NetworkMemberGovernance} makes the admission itself tamper-proof,
    /// but a batch pairing that call with a rogue one would execute both if a quorum approved it. This
    /// is why the flow has every approver build its own transaction from the chain: a member that never
    /// sees a payload it did not derive cannot be handed one. Only a Safe guard would forbid the extra
    /// call outright, and there is none.
    function test_Governance_SafeStillExecutesWhateverTheQuorumSigned() public {
        _setUpSafeGovernedContracts();
        address attacker = makeAddr("attacker");

        address[] memory targets = new address[](2);
        bytes[] memory calls = new bytes[](2);
        targets[0] = address(governance);
        calls[0] =
            _admissionCall(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);
        // The smuggled call: an extra owner, and a threshold of one.
        targets[1] = address(safe);
        calls[1] = abi.encodeCall(OwnerManager.addOwnerWithThreshold, (attacker, 1));

        _execBatchFromSafe(targets, calls, _quorum());

        assertTrue(safe.isOwner(attacker));
        assertEq(safe.getThreshold(), 1);
    }

    /// @dev The threshold no caller can touch: `admitMember` takes no threshold argument, so the
    /// only value it can set is the one {NetworkMemberGovernance.governanceThreshold} computes.
    function test_Governance_AdmissionCannotCarryAWrongThreshold() public {
        _setUpSafeGovernedContracts();

        _admitMember(networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner);

        assertEq(safe.getThreshold(), governance.governanceThreshold(safe.getOwners().length));
    }
}
