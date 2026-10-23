// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";
import { IRevocation } from "./revocation/interfaces/IRevocation.sol";
import { IRevocationRegistries } from "./revocation/interfaces/IRevocationRegistries.sol";

import { NetworkMemberGate } from "./base/NetworkMemberGate.sol";

/// @title CredentialRevocationRegistry
/// @notice The network's one revocation registry. A single tree holds every revoked credential,
/// whoever issued it, and every write is authorised by an anonymous membership proof from an
/// approved network member.
/// @dev One registry rather than one per issuer is what keeps issuer hiding intact. The circuit hides
/// which approved issuer signed a credential and outputs the root it proved non-membership against;
/// picking which registry to ask about that root would name the issuer. So {isValidRoot} takes the
/// root alone, and with one tree, which tree a holder syncs says nothing about its issuer either.
///
/// The tree, its root history and its LeanIMT+ stay in the {IRevocation} deployment. This contract
/// adds only who may write and a registry-free read surface.
///
/// The registry's admin is this contract, and no write path reads `msg.sender`, so a member can
/// submit from a fresh stealth address with a paymaster covering the gas. The cost is that any
/// approved member can revoke any credential unattributably; {unrevoke} makes a wrong one repairable.
///
/// The tree reads a holder needs are public on {REVOCATION} under {REGISTRY_ID}, not mirrored here.
contract CredentialRevocationRegistry is NetworkMemberGate {
    /// @notice The mutation a member proof authorises.
    enum RevocationAction {
        Revoke,
        RevokeMany,
        Unrevoke,
        UpdateCommitment
    }

    /// @dev Domain of the message a proof commits to. Clients derive the message identically.
    string constant REVOCATION_MESSAGE_DOMAIN = "coordination-network.credential-revocation-registry.revocation.v1";

    /// @notice The constant half of a revocation message, hashed once at deployment.
    bytes32 public immutable REVOCATION_DOMAIN_SEPARATOR;

    /// @notice The revocation service holding this registry's tree and root history.
    IRevocation public immutable REVOCATION;

    /// @notice This network's registry on {REVOCATION}, created at deployment and administered by
    /// this contract.
    /// @dev Public because a holder needs it to read the tree off {REVOCATION}. A verifier does not.
    uint256 public immutable REGISTRY_ID;

    /// @notice Thrown when the deployment is given no revocation service.
    error ZeroRevocationService();

    /// @param semaphore The Semaphore deployment holding the approved-member group.
    /// @param networkMemberGroupId The approved-member group to gate writes on.
    /// @param revocation The revocation service to create this network's registry on.
    constructor(ISemaphore semaphore, uint256 networkMemberGroupId, IRevocation revocation)
        NetworkMemberGate(semaphore, networkMemberGroupId)
    {
        if (address(revocation) == address(0)) revert ZeroRevocationService();

        REVOCATION = revocation;

        // This contract is the admin, so the gated functions below are the only way in. The tree
        // starts empty, and the circuit canonicalises an empty-registry witness to a zero root, so
        // presentations verify from the first block.
        REGISTRY_ID = revocation.createRegistry(address(this));

        REVOCATION_DOMAIN_SEPARATOR = keccak256(abi.encode(REVOCATION_MESSAGE_DOMAIN, address(this)));
    }

    /// @notice Revokes a credential, on an approved member's authority.
    /// @param revocationCommitment The credential's revocation commitment.
    /// @param lowLeafIndex The commitment's predecessor slot, computed off chain against the tree
    /// state this transaction executes in. If another write lands first this reverts; recompute and
    /// resubmit the same proof.
    /// @param proof Membership proof bound to this exact revocation.
    function revoke(uint256 revocationCommitment, uint256 lowLeafIndex, NetworkMemberProof calldata proof)
        external
        onlyNetworkMember(_revocationMessage(RevocationAction.Revoke, revocationCommitment), proof)
    {
        REVOCATION.revoke(REGISTRY_ID, revocationCommitment, lowLeafIndex);
    }

    /// @notice Revokes several credentials in one call, on an approved member's authority.
    /// @dev Cheaper than one {revoke} per commitment, and the answer to contention on a shared tree:
    /// one proof and one transaction for the batch.
    /// @param revocationCommitments The commitments to revoke, in insertion order.
    /// @param lowLeafIndices Each commitment's predecessor index, in the tree state after the
    /// earlier commitments in the batch have been inserted.
    /// @param proof Membership proof bound to this exact batch.
    function revokeMany(
        uint256[] calldata revocationCommitments,
        uint256[] calldata lowLeafIndices,
        NetworkMemberProof calldata proof
    ) external onlyNetworkMember(_revocationBatchMessage(revocationCommitments), proof) {
        REVOCATION.revokeMany(REGISTRY_ID, revocationCommitments, lowLeafIndices);
    }

    /// @notice Undoes a revocation, on an approved member's authority.
    /// @dev The credential becomes valid again everywhere, including for verifiers still on an older
    /// root. Here because an anonymous revocation cannot be pinned on anyone, so a wrong one has to
    /// be repairable.
    /// @param revocationCommitment The revoked commitment.
    /// @param predecessorIndex The physical index of the leaf whose `nextValue` is the commitment.
    /// @param proof Membership proof bound to this exact un-revocation.
    function unrevoke(uint256 revocationCommitment, uint256 predecessorIndex, NetworkMemberProof calldata proof)
        external
        onlyNetworkMember(_revocationMessage(RevocationAction.Unrevoke, revocationCommitment), proof)
    {
        REVOCATION.unrevoke(REGISTRY_ID, revocationCommitment, predecessorIndex);
    }

    /// @notice Replaces a revoked commitment with another one, reusing its slot, on an approved
    /// member's authority.
    /// @param oldRevocationCommitment The revoked commitment to replace.
    /// @param newRevocationCommitment The commitment to put in its place.
    /// @param oldPredecessorIndex The physical index of the old commitment's predecessor.
    /// @param newPredecessorIndex The physical index of the new commitment's predecessor, in the
    /// tree state after the old commitment has been unlinked.
    /// @param proof Membership proof bound to this exact replacement.
    function updateRevocationCommitment(
        uint256 oldRevocationCommitment,
        uint256 newRevocationCommitment,
        uint256 oldPredecessorIndex,
        uint256 newPredecessorIndex,
        NetworkMemberProof calldata proof
    ) external onlyNetworkMember(_revocationUpdateMessage(oldRevocationCommitment, newRevocationCommitment), proof) {
        REVOCATION.updateRevocationCommitment(
            REGISTRY_ID, oldRevocationCommitment, newRevocationCommitment, oldPredecessorIndex, newPredecessorIndex
        );
    }

    /// @notice Whether a root may back a revocation proof right now.
    /// @dev The verifier's only on-chain read, and it takes the root alone, so a verification has
    /// nothing issuer-specific to pass. Accepts the current root, plus any root superseded less than
    /// the registry's window ago, so a revocation landing mid-presentation spares honest proofs.
    /// @param revocationRoot The root the proof was built against.
    /// @return True if the root is currently accepted.
    function isValidRoot(uint256 revocationRoot) external view returns (bool) {
        return REVOCATION.isValidRoot(REGISTRY_ID, revocationRoot);
    }

    /// @notice The registry's current revocation root.
    /// @dev Mirrored here because building a non-membership proof starts with it. Zero while the tree
    /// is empty, matching the circuit's empty-registry witness. The cast is because tree reads live on
    /// {IRevocationRegistries}, which the same deployment implements.
    /// @return The root.
    function getRevocationRoot() external view returns (uint256) {
        return IRevocationRegistries(address(REVOCATION)).getRevocationRoot(REGISTRY_ID);
    }

    /// @dev Binds a proof to one single-commitment mutation: the action and the commitment, at this
    /// registry on this chain. The separator and chain id matter because this contract does not own
    /// its group: two deployments can share one, and one deployment can sit at the same address on two
    /// chains with the same root.
    ///
    /// The predecessor index is not bound. It is a witness the LeanIMT+ validates, not a privilege, so
    /// leaving it out lets a member who lost a race recompute it and resubmit the same proof; a revert
    /// does not burn the nullifier.
    /// @param action Which mutation the proof authorises.
    /// @param revocationCommitment The commitment being written.
    function _revocationMessage(RevocationAction action, uint256 revocationCommitment) private view returns (uint256) {
        return uint256(
            keccak256(abi.encodePacked(REVOCATION_DOMAIN_SEPARATOR, block.chainid, action, revocationCommitment))
        );
    }

    /// @dev Binds a proof to one batch. The commitments come last and are the only variable-length
    /// field, so the encoding is unambiguous. The action differs from {RevocationAction.Revoke}
    /// because a one-commitment batch would otherwise pack identically to a single revocation.
    /// @param revocationCommitments The commitments being revoked, in insertion order.
    function _revocationBatchMessage(uint256[] calldata revocationCommitments) private view returns (uint256) {
        return uint256(
            keccak256(
                abi.encodePacked(
                    REVOCATION_DOMAIN_SEPARATOR, block.chainid, RevocationAction.RevokeMany, revocationCommitments
                )
            )
        );
    }

    /// @dev Binds a proof to one replacement. Both commitments are fixed width, so binding both fixes
    /// which replacement is authorised.
    /// @param oldRevocationCommitment The commitment being replaced.
    /// @param newRevocationCommitment The commitment replacing it.
    function _revocationUpdateMessage(uint256 oldRevocationCommitment, uint256 newRevocationCommitment)
        private
        view
        returns (uint256)
    {
        return uint256(
            keccak256(
                abi.encodePacked(
                    REVOCATION_DOMAIN_SEPARATOR,
                    block.chainid,
                    RevocationAction.UpdateCommitment,
                    oldRevocationCommitment,
                    newRevocationCommitment
                )
            )
        );
    }
}
