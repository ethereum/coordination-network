// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { IApprovedIssuerSet } from "./interfaces/IApprovedIssuerSet.sol";

/// @title NetworkMemberRegistry
/// @notice Holds network member state: who is approved, and each member's keys.
/// @dev Governance. The owner is the governance Safe, a multisig of the governing members, and it
/// is the only writer of the approved-network-member set: nothing here lets a single operator admit
/// or remove a member. Joining is permissionless in the request direction and
/// governed in the admission direction:
///
///  1. a prospective member calls {requestToJoin} itself, which stores nothing and only emits
///     {NetworkMemberJoinRequested}. Already-approved members watch that event off chain;
///  2. enough of them sign a Safe transaction calling {approveNetworkMember} to meet the Safe's
///     threshold, and the Safe executes it.
///
/// Admission is three calls the Safe batches into one transaction, because the state that defines an
/// approved network member lives in three places: the record here, the member's leaf in the Semaphore
/// group NetworkMemberGroup administers, and the member's governance signer in the Safe's own owner
/// set. Batching them means a member is never approved without its group leaf, and never an approver
/// without being a member. This contract records which keys belong to which member; it holds neither
/// the group nor the owner set.
///
/// A member's id is `keccak256(X || Y)` of its account key, a secp256k1 public key, and the key's
/// Ethereum address is the member's auth address. Both write paths take the key rather than the id, so
/// an id always has exactly one key behind it and no id exists that no key derives.
///
/// The onboarding procedure is in `docs/configuration/network-member-onboarding.md`.
contract NetworkMemberRegistry is Ownable2Step {
    uint256 public constant META_STEALTH_ADDRESS_LENGTH = 66;

    /// @dev The secp256k1 field prime.
    uint256 internal constant SECP256K1_P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;

    /// @notice The address that maintains a network member's record. The Ethereum address of the account key
    /// the member's id is derived from.
    mapping(bytes32 memberNetworkId => address authAddress) public networkMemberAuthAddress;

    /// @notice The network member networkId => meta-stealth address mapping.
    /// Network members resolve here, not in the IdentityRegistry.
    mapping(bytes32 memberNetworkId => bytes metaStealthAddress) public identity;

    /// @notice The network member's Semaphore identity commitment, its leaf in the approved-member
    /// group NetworkMemberGroup administers.
    mapping(bytes32 memberNetworkId => uint256 semaphoreCommitment) public semaphoreCommitmentOf;

    /// @notice The network member's governance signer: the address that votes for it as an owner of
    /// the governance Safe. Recorded here so a removal can find the owner to drop without replaying
    /// the member's admission history.
    mapping(bytes32 memberNetworkId => address governanceSigner) public governanceSignerOf;

    /// @notice The set holding members' credential signing keys. Wired once, after deployment.
    IApprovedIssuerSet public approvedIssuerSet;

    event NetworkMemberJoinRequested(
        bytes32 indexed memberNetworkId,
        uint256 accountKeyX,
        uint256 accountKeyY,
        uint256 semaphoreCommitment,
        address governanceSigner,
        string metadataURI
    );
    event NetworkMemberApproved(bytes32 indexed memberNetworkId);
    event NetworkMemberRemoved(bytes32 indexed memberNetworkId);
    event NetworkMemberIdentityRegistered(bytes32 indexed memberNetworkId, bytes metaStealthAddress);
    event GovernanceSignerPublished(bytes32 indexed memberNetworkId, address indexed governanceSigner);
    event ApprovedIssuerSetWired(address indexed approvedIssuerSet);

    error AlreadyApproved(bytes32 memberNetworkId);
    error NotApproved(bytes32 memberNetworkId);
    error InvalidMetaStealthAddressLength();
    error UnauthorizedCaller();
    error AccountKeyNotOnCurve();
    error ZeroGovernanceSigner();
    error ZeroSemaphoreCommitment();
    error GovernanceSignerIsAuthAddress();
    error ZeroApprovedIssuerSet();
    error ApprovedIssuerSetAlreadyWired();
    error ApprovedIssuerSetNotBoundToThisRegistry();
    error IssuerSetNotWired();

    /// @dev Restricts a network member record write to the network member's current auth address,
    /// or to governance.
    /// @param memberNetworkId The network member whose record is being written.
    modifier onlyAuthAddressOrGovernance(bytes32 memberNetworkId) {
        _onlyAuthAddressOrGovernance(memberNetworkId);
        _;
    }

    function _onlyAuthAddressOrGovernance(bytes32 memberNetworkId) internal view {
        if (msg.sender != networkMemberAuthAddress[memberNetworkId] && msg.sender != owner()) {
            revert UnauthorizedCaller();
        }
    }

    /// @param governance The governance Safe. It becomes the owner, and the sole approver.
    constructor(address governance) Ownable(governance) { }

    /// @notice Whether a network member is currently approved.
    /// @param memberNetworkId The network member's networkId.
    /// @return True if the network member is approved.
    function isApproved(bytes32 memberNetworkId) external view returns (bool) {
        return networkMemberAuthAddress[memberNetworkId] != address(0);
    }

    /// @notice The networkId of the member whose account key is `(accountKeyX, accountKeyY)`.
    /// @param accountKeyX The X coordinate of the account key.
    /// @param accountKeyY The Y coordinate of the account key.
    /// @return The member's networkId, `keccak256(X || Y)`.
    function memberNetworkIdOf(uint256 accountKeyX, uint256 accountKeyY) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(accountKeyX, accountKeyY));
    }

    /// @notice Asks the approved network members to admit the member with this account key.
    /// Permissionless, and callable by anyone holding the key.
    /// @dev Stores nothing and confers nothing. It is the announcement half of the join flow: the
    /// approved members watch this event, and admission happens only if enough of them sign the
    /// governance Safe transaction that calls {approveNetworkMember}. The caller must be the auth
    /// address of the account key, so nobody can post a request on another member's behalf.
    /// @param accountKeyX The X coordinate of the requester's account key, a secp256k1 public key.
    /// @param accountKeyY The Y coordinate of the requester's account key.
    /// @param semaphoreCommitment The Semaphore identity commitment the requester wants in the group.
    /// @param governanceSigner The address the requester wants added to the governance Safe, so it can
    /// vote on later candidates. Must differ from the auth address: the auth address is a hot key that
    /// signs routine record writes, and Safe ownership should not sit on a key used that way.
    /// @param metadataURI Where the approvers can fetch this requester's vetting material. Any URI the
    /// network has agreed on, and it may be empty. The contract neither reads nor stores it.
    function requestToJoin(
        uint256 accountKeyX,
        uint256 accountKeyY,
        uint256 semaphoreCommitment,
        address governanceSigner,
        string calldata metadataURI
    ) external {
        (bytes32 memberNetworkId, address authAddress) = _memberOf(accountKeyX, accountKeyY);

        if (msg.sender != authAddress) revert UnauthorizedCaller();
        if (networkMemberAuthAddress[memberNetworkId] != address(0)) revert AlreadyApproved(memberNetworkId);
        if (semaphoreCommitment == 0) revert ZeroSemaphoreCommitment();
        if (governanceSigner == address(0)) revert ZeroGovernanceSigner();
        if (governanceSigner == authAddress) revert GovernanceSignerIsAuthAddress();

        emit NetworkMemberJoinRequested(
            memberNetworkId, accountKeyX, accountKeyY, semaphoreCommitment, governanceSigner, metadataURI
        );
    }

    /// @notice Admits a network member to the approved set.
    /// @dev Callable only by the governance Safe, so admission always carries the signatures of a
    /// threshold of approved members. The auth address is the address of the account key, which the Safe's
    /// signers pin by approving its coordinates. The companion calls in the same Safe transaction are
    /// `NetworkMemberGroup.addNetworkMember` and the Safe's own `addOwnerWithThreshold`.
    ///
    /// Requires the issuer set to already be wired, for the same reason {removeNetworkMember} does:
    /// without it a member could be admitted into a state {removeNetworkMember} can never remove it
    /// from, since that function refuses to run while the set is unwired.
    /// @param accountKeyX The X coordinate of the member's account key, a secp256k1 public key.
    /// @param accountKeyY The Y coordinate of the member's account key.
    /// @param semaphoreCommitment The member's Semaphore identity commitment. Must be non-zero, which
    /// the Semaphore group requires too, so a record cannot hold a commitment the group would refuse.
    /// @param governanceSigner The member's governance signer, the owner added to the Safe alongside
    /// this call.
    function approveNetworkMember(
        uint256 accountKeyX,
        uint256 accountKeyY,
        uint256 semaphoreCommitment,
        address governanceSigner
    ) external onlyOwner {
        if (address(approvedIssuerSet) == address(0)) revert IssuerSetNotWired();

        (bytes32 memberNetworkId, address authAddress) = _memberOf(accountKeyX, accountKeyY);

        if (networkMemberAuthAddress[memberNetworkId] != address(0)) revert AlreadyApproved(memberNetworkId);
        if (semaphoreCommitment == 0) revert ZeroSemaphoreCommitment();
        if (governanceSigner == address(0)) revert ZeroGovernanceSigner();
        if (governanceSigner == authAddress) revert GovernanceSignerIsAuthAddress();

        networkMemberAuthAddress[memberNetworkId] = authAddress;
        semaphoreCommitmentOf[memberNetworkId] = semaphoreCommitment;
        governanceSignerOf[memberNetworkId] = governanceSigner;

        emit NetworkMemberApproved(memberNetworkId);
        emit GovernanceSignerPublished(memberNetworkId, governanceSigner);
    }

    /// @notice Wires the approved-issuer set. Callable once.
    /// @dev Deliberately not a constructor argument: the set needs this registry's address, so the
    /// registry has to exist first.
    /// @param newApprovedIssuerSet The set this registry retires keys in when it removes a member.
    function setApprovedIssuerSet(address newApprovedIssuerSet) external onlyOwner {
        if (address(approvedIssuerSet) != address(0)) revert ApprovedIssuerSetAlreadyWired();
        if (newApprovedIssuerSet == address(0)) revert ZeroApprovedIssuerSet();

        // The set only answers its own registry, and this write cannot be redone. Wiring one built
        // against a different registry would make every removal revert, with no way to rewire.
        if (IApprovedIssuerSet(newApprovedIssuerSet).memberRegistry() != address(this)) {
            revert ApprovedIssuerSetNotBoundToThisRegistry();
        }

        approvedIssuerSet = IApprovedIssuerSet(newApprovedIssuerSet);
        emit ApprovedIssuerSetWired(newApprovedIssuerSet);
    }

    /// @notice Removes a network member and retires every signing key it published.
    /// @dev The companion calls in the same Safe transaction are
    /// `NetworkMemberGroup.removeNetworkMember` and the Safe's own `removeOwner`.
    ///
    /// Both halves happen here so they cannot come apart. Removing a member while leaving its key in
    /// the set would let it keep signing credentials that verify, and nothing detects that: a
    /// verifier cannot attribute a credential to a member. Reverting while the set is unwired is the
    /// safe direction, since the alternative is removing members without disarming their keys.
    /// @param memberNetworkId The network member to remove.
    function removeNetworkMember(bytes32 memberNetworkId) external onlyOwner {
        if (networkMemberAuthAddress[memberNetworkId] == address(0)) revert NotApproved(memberNetworkId);

        IApprovedIssuerSet issuerSet = approvedIssuerSet;
        if (address(issuerSet) == address(0)) revert IssuerSetNotWired();

        delete networkMemberAuthAddress[memberNetworkId];
        delete identity[memberNetworkId];
        delete semaphoreCommitmentOf[memberNetworkId];
        delete governanceSignerOf[memberNetworkId];

        emit NetworkMemberRemoved(memberNetworkId);

        issuerSet.retireAllIssuerKeys(memberNetworkId);
    }

    /// @notice Sets a network member's meta-stealth address. Callable by the network member's auth
    /// address or by governance.
    /// @param memberNetworkId The network member whose identity is being set.
    /// @param newMetaStealthAddress The ERC-6538 meta-stealth address to store. Must be 66 bytes.
    function registerNetworkMemberIdentity(bytes32 memberNetworkId, bytes calldata newMetaStealthAddress)
        external
        onlyAuthAddressOrGovernance(memberNetworkId)
    {
        if (networkMemberAuthAddress[memberNetworkId] == address(0)) revert NotApproved(memberNetworkId);
        if (newMetaStealthAddress.length != META_STEALTH_ADDRESS_LENGTH) revert InvalidMetaStealthAddressLength();

        identity[memberNetworkId] = newMetaStealthAddress;
        emit NetworkMemberIdentityRegistered(memberNetworkId, newMetaStealthAddress);
    }

    /// @dev Derives a member's id and auth address from its account key, after checking the key is a
    /// secp256k1 point. Without the check, a pair that is no key could still be admitted as an id.
    function _memberOf(uint256 accountKeyX, uint256 accountKeyY)
        internal
        pure
        returns (bytes32 memberNetworkId, address authAddress)
    {
        if (
            accountKeyX >= SECP256K1_P || accountKeyY >= SECP256K1_P
                || mulmod(accountKeyY, accountKeyY, SECP256K1_P)
                    != addmod(
                        mulmod(mulmod(accountKeyX, accountKeyX, SECP256K1_P), accountKeyX, SECP256K1_P), 7, SECP256K1_P
                    )
        ) revert AccountKeyNotOnCurve();

        memberNetworkId = memberNetworkIdOf(accountKeyX, accountKeyY);
        authAddress = address(uint160(uint256(memberNetworkId)));
    }
}
