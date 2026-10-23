// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISafeGovernance, ISafeOwnerManager } from "./interfaces/ISafeGovernance.sol";
import { NetworkMemberGroup } from "./NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "./NetworkMemberRegistry.sol";

/// @title NetworkMemberGovernance
/// @notice The governance operations of the network, each as one call: admit a member, remove one, and
/// leave voluntarily.
/// @dev Admitting a member changes state in three places: the record in the NetworkMemberRegistry,
/// the leaf in the Semaphore group NetworkMemberGroup administers, and the Safe's own owner set, which
/// is what makes the new member an approver of the next candidate. Without this contract those are
/// three calls someone has to pack into a MultiSend batch, with the threshold in the third written by
/// whoever built it. Every approver would then have to decode that batch and recompute the threshold to
/// know what it is approving.
///
/// Here they are one call whose behaviour is fixed in code:
///
///  - the threshold is not an input. {governanceThreshold} computes it from the Safe's live owner
///    count, so no call through this module can lower it. Direct Safe calls can, so admission and
///    removal also refuse to run while the Safe's threshold is not {governanceThreshold} of its
///    owners;
///  - removal reads the member's commitment and signer from the registry, so it cannot be pointed at
///    the wrong leaf or the wrong owner;
///  - nothing takes arbitrary calldata, so a quorum approving `admitMember` is approving an admission
///    and nothing else;
///  - each operation pins the member count it was built against. A Safe evaluates a quorum at execution
///    time, and normally relies on its nonce advancing to invalidate transactions signed against an
///    older owner set. A module call does not advance the nonce, so {exitNetwork} can shrink the set
///    and the threshold with it while approvals are still accumulating. Without the pin, three
///    approvals recorded when four were required would execute once a departure made three a
///    majority. With it, any change to the member set invalidates every transaction built against the
///    old one.
///
/// What an approver has to check shrinks to the arguments of a single call.
///
/// Authority. Admission and removal are the Safe's alone, so both carry a majority of the members'
/// signatures. To reach the Safe's owner-set functions, which only the Safe may call, this contract
/// must be enabled as a Safe module: it makes the Safe call itself. That module power is why the
/// {onlySafe} check is the most security-critical line here.
///
/// {exitNetwork} is the one door that does not go through the Safe, because departure should not need
/// the consent of the members being left. It is confined by a different invariant, and the second most
/// important line here: a caller may only ever act on the membership whose governance signer it is.
/// The worst a stolen governance signer achieves through it is destroying that one member's own
/// membership, which is also the worst that member could do to itself.
///
/// The registry and the group stay owned by the Safe, not by this contract, so the Safe keeps its own
/// direct path to those contracts and this contract is purely additive.
///
/// All three addresses are immutable, so moving governance to a new Safe means deploying a new
/// orchestrator against it, transferring the registry and the group, and enabling the new module.
contract NetworkMemberGovernance {
    /// @notice The smallest member set the network will shrink to. One, so the network is symmetric:
    /// it can be founded with a single member and it can shrink back to one, rather than trapping a
    /// shrinking set at a size it can never leave.
    /// @dev Zero is refused because an ownerless Safe is unrecoverable: no key could ever admit a
    /// member again, and the registry and the group would be frozen with no path back. A single
    /// member is a bootstrap state with no fault tolerance and no check on that member, documented
    /// in the runbook, not a size to operate at.
    uint256 public constant MIN_MEMBERS = 1;

    /// @notice The governance Safe. Its owner set is the approver set.
    ISafeGovernance public immutable SAFE;

    /// @notice The registry holding member records.
    NetworkMemberRegistry public immutable REGISTRY;

    /// @notice The contract administering the approved-member Semaphore group.
    NetworkMemberGroup public immutable GROUP;

    event NetworkMemberAdmitted(bytes32 indexed memberNetworkId, address governanceSigner, uint256 threshold);
    event NetworkMemberRemoved(bytes32 indexed memberNetworkId, address governanceSigner, uint256 threshold);
    event NetworkMemberExited(bytes32 indexed memberNetworkId, address governanceSigner, uint256 threshold);

    error OnlyGovernanceSafe();
    error OnlyGovernanceSigner(bytes32 memberNetworkId);
    error ZeroAddress();
    error NotApproved(bytes32 memberNetworkId);
    error MemberSetTooSmall(uint256 memberCountAfter);
    error MemberCountChanged(uint256 expected, uint256 actual);
    error ThresholdMismatch(uint256 expected, uint256 actual);
    error NotASafeOwner(address account);
    error SafeCallFailed(bytes returnData);

    /// @dev Restricts an operation to the governance Safe, so it always carries a majority of the
    /// members' signatures. This contract is a Safe module, which means it can make the Safe act; this
    /// check is what confines that power to the two operations it guards, {admitMember} and
    /// {removeMember}. {exitNetwork} is guarded by its own invariant instead.
    modifier onlySafe() {
        if (msg.sender != address(SAFE)) revert OnlyGovernanceSafe();
        _;
    }

    /// @param safe The governance Safe.
    /// @param registry The member registry, owned by that Safe.
    /// @param group The member group, owned by that Safe.
    constructor(ISafeGovernance safe, NetworkMemberRegistry registry, NetworkMemberGroup group) {
        if (address(safe) == address(0) || address(registry) == address(0) || address(group) == address(0)) {
            revert ZeroAddress();
        }

        SAFE = safe;
        REGISTRY = registry;
        GROUP = group;
    }

    /// @notice The signatures a Safe of `memberCount` network members must require: a majority, one
    /// more than half. Five members need three, eight need five.
    /// @dev The rule, on chain and computed rather than supplied. Every operation here sets the
    /// threshold from this function, so no caller can move it anywhere else.
    /// @param memberCount How many members the Safe has owners for, after the operation.
    /// @return The required number of signatures.
    function governanceThreshold(uint256 memberCount) public pure returns (uint256) {
        return memberCount / 2 + 1;
    }

    /// @notice The threshold the Safe will require once one more member is admitted.
    /// @return The threshold after an admission.
    function thresholdAfterAdmission() external view returns (uint256) {
        return governanceThreshold(SAFE.getOwners().length + 1);
    }

    /// @notice Admits a network member: its record, its group leaf, and its seat at the Safe.
    /// @dev One call, so a quorum cannot be talked into signing a differently shaped batch, and the
    /// threshold comes from {governanceThreshold} rather than from the calldata.
    /// @param accountKeyX The X coordinate of the member's account key.
    /// @param accountKeyY The Y coordinate of the member's account key.
    /// @param semaphoreCommitment Its Semaphore identity commitment.
    /// @param governanceSigner The address that becomes its seat at the Safe.
    /// @param expectedMemberCount The member count this transaction was built against. Not a policy
    /// input: the threshold is still computed, and this only makes the transaction stale the moment the
    /// member set changes, so signatures cannot carry over to a set their signers never saw.
    function admitMember(
        uint256 accountKeyX,
        uint256 accountKeyY,
        uint256 semaphoreCommitment,
        address governanceSigner,
        uint256 expectedMemberCount
    ) external onlySafe {
        uint256 memberCount = _checkSafeState(expectedMemberCount);
        uint256 threshold = governanceThreshold(memberCount + 1);

        _execFromSafe(
            address(REGISTRY),
            abi.encodeCall(
                NetworkMemberRegistry.approveNetworkMember,
                (accountKeyX, accountKeyY, semaphoreCommitment, governanceSigner)
            )
        );
        _execFromSafe(address(GROUP), abi.encodeCall(NetworkMemberGroup.addNetworkMember, (semaphoreCommitment)));
        _execFromSafe(
            address(SAFE), abi.encodeCall(ISafeOwnerManager.addOwnerWithThreshold, (governanceSigner, threshold))
        );

        emit NetworkMemberAdmitted(REGISTRY.memberNetworkIdOf(accountKeyX, accountKeyY), governanceSigner, threshold);
    }

    /// @notice Removes a network member from all three places.
    /// @dev The commitment and the signer are read from the registry rather than passed in, so a
    /// removal cannot be pointed at another member's leaf or another member's seat.
    /// @param memberNetworkId The member to remove.
    /// @param merkleProofSiblings The membership proof for its leaf, computed off chain against the
    /// group state this transaction will execute in.
    /// @param expectedMemberCount The member count this transaction was built against, for the reason
    /// given on {admitMember}.
    function removeMember(bytes32 memberNetworkId, uint256[] calldata merkleProofSiblings, uint256 expectedMemberCount)
        external
        onlySafe
    {
        _checkSafeState(expectedMemberCount);

        address governanceSigner = REGISTRY.governanceSignerOf(memberNetworkId);
        if (governanceSigner == address(0)) revert NotApproved(memberNetworkId);

        uint256 threshold = _withdrawMember(memberNetworkId, governanceSigner, merkleProofSiblings);

        emit NetworkMemberRemoved(memberNetworkId, governanceSigner, threshold);
    }

    /// @notice Leaves the network, giving up this member's record, its group leaf and its seat.
    /// @dev Callable by the member's own governance signer and nobody else, so a member can leave
    /// without asking the members it is leaving. It is also how a member that is winding down avoids
    /// leaving a dead seat behind: a seat nobody can sign for still counts toward the owner count, and
    /// therefore toward the threshold everyone else has to reach.
    ///
    /// Departure is irreversible in one respect worth knowing before calling it: rejoining means a new
    /// request and a new place in the Semaphore group, and every credential this member issued stops
    /// verifying as soon as its record is gone.
    /// @param memberNetworkId The member leaving, whose governance signer must be the caller.
    /// @param merkleProofSiblings The membership proof for its leaf, computed off chain against the
    /// group state this transaction will execute in.
    function exitNetwork(bytes32 memberNetworkId, uint256[] calldata merkleProofSiblings) external {
        address governanceSigner = REGISTRY.governanceSignerOf(memberNetworkId);
        if (governanceSigner == address(0)) revert NotApproved(memberNetworkId);
        // The invariant that confines this door: the caller acts on its own membership, never another's.
        if (msg.sender != governanceSigner) revert OnlyGovernanceSigner(memberNetworkId);

        uint256 threshold = _withdrawMember(memberNetworkId, governanceSigner, merkleProofSiblings);

        emit NetworkMemberExited(memberNetworkId, governanceSigner, threshold);
    }

    /// @dev Reverts unless the Safe's owner set is still the size the caller's transaction was built
    /// against, and its threshold is still {governanceThreshold} of that set. {exitNetwork} needs no
    /// such check: it carries no signatures to go stale, and a member must always be able to leave.
    ///
    /// The Safe can change its own threshold directly, outside this contract. This cannot stop that,
    /// but it refuses to act on a Safe that has drifted, so the drift surfaces at the next governance
    /// action instead of persisting silently. A quorum restores it with `changeThreshold`.
    ///
    /// Checks the owner count and threshold, not who the owners are. A quorum acting on the Safe
    /// directly can seat an address the registry doesn't know, and this check won't catch it.
    /// @param expectedMemberCount The member count the transaction assumed.
    /// @return memberCount The live member count, equal to `expectedMemberCount`.
    function _checkSafeState(uint256 expectedMemberCount) internal view returns (uint256 memberCount) {
        memberCount = SAFE.getOwners().length;

        if (memberCount != expectedMemberCount) revert MemberCountChanged(expectedMemberCount, memberCount);

        uint256 expected = governanceThreshold(memberCount);
        uint256 threshold = SAFE.getThreshold();
        if (threshold != expected) revert ThresholdMismatch(expected, threshold);
    }

    /// @dev Takes a member out of the registry, the group and the Safe's owner set, and moves the
    /// threshold down with the member count. Shared by {removeMember} and {exitNetwork}, which differ
    /// only in who may ask.
    /// @param memberNetworkId The member being withdrawn.
    /// @param governanceSigner Its governance signer, already read from the registry.
    /// @param merkleProofSiblings The membership proof for its leaf.
    /// @return threshold The threshold the Safe now requires.
    function _withdrawMember(bytes32 memberNetworkId, address governanceSigner, uint256[] calldata merkleProofSiblings)
        internal
        returns (uint256 threshold)
    {
        // Ownership first: a member whose seat is already gone should say so, rather than report
        // whatever the floor check happens to conclude about a set it is not part of.
        address previousOwner = _previousOwner(governanceSigner);

        uint256 memberCountAfter = SAFE.getOwners().length - 1;
        if (memberCountAfter < MIN_MEMBERS) revert MemberSetTooSmall(memberCountAfter);

        uint256 semaphoreCommitment = REGISTRY.semaphoreCommitmentOf(memberNetworkId);
        threshold = governanceThreshold(memberCountAfter);

        _execFromSafe(address(REGISTRY), abi.encodeCall(NetworkMemberRegistry.removeNetworkMember, (memberNetworkId)));
        _execFromSafe(
            address(GROUP),
            abi.encodeCall(NetworkMemberGroup.removeNetworkMember, (semaphoreCommitment, merkleProofSiblings))
        );
        _execFromSafe(
            address(SAFE), abi.encodeCall(ISafeOwnerManager.removeOwner, (previousOwner, governanceSigner, threshold))
        );
    }

    /// @dev The owner preceding `owner` in the Safe's owner linked list, which `removeOwner` takes.
    /// Walked on chain so no caller has to supply it. The sentinel address precedes the first
    /// owner.
    /// @param owner The owner being removed.
    function _previousOwner(address owner) internal view returns (address) {
        address[] memory owners = SAFE.getOwners();

        for (uint256 i = 0; i < owners.length; ++i) {
            if (owners[i] == owner) return i == 0 ? address(0x1) : owners[i - 1];
        }

        revert NotASafeOwner(owner);
    }

    /// @dev Makes the Safe perform `data` against `to`, as an enabled module. The Safe returns a
    /// failure flag instead of bubbling an inner revert, so the reason is bubbled here to keep a
    /// failed governance operation diagnosable.
    /// @param to The contract the Safe should call.
    /// @param data The calldata.
    function _execFromSafe(address to, bytes memory data) internal {
        (bool success, bytes memory returnData) = SAFE.execTransactionFromModuleReturnData(to, 0, data, 0);

        if (!success) revert SafeCallFailed(returnData);
    }
}
