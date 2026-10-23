// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { NetworkMemberGate } from "./base/NetworkMemberGate.sol";

/// @title IdentityRegistry
/// @notice Resolves a networkId to its meta-stealth address. Reads are public and ungated. Every
/// write is authorised by an anonymous Semaphore membership proof against the approved-member
/// group, so the registry learns that an approved network member made the change and not which one.
/// @dev No write path looks at `msg.sender`, which is what lets a member submit from a fresh stealth
/// address with a paymaster covering the gas. The proof is bound to the exact update it carries: see
/// NetworkMemberGate for the binding, and Semaphore for membership, the recent-root window and the
/// nullifier set that stops a proof being submitted twice.
contract IdentityRegistry is NetworkMemberGate {
    /// @notice The update a member proof authorises.
    enum UpdateAction {
        Register,
        Update,
        Remove
    }

    /// @dev Domain of the message a proof commits to. Clients derive the message identically.
    string constant UPDATE_MESSAGE_DOMAIN = "coordination-network.identity-registry.update.v1";

    uint256 public constant META_STEALTH_ADDRESS_LENGTH = 66;

    /// @notice The constant half of an update message, hashed once at deployment.
    bytes32 public immutable UPDATE_DOMAIN_SEPARATOR;

    /// @notice The networkId => meta-stealth address mapping
    mapping(bytes32 networkId => bytes metaStealthAddress) public identity;

    event IdentityRegistered(bytes32 indexed networkId, bytes metaStealthAddress);
    event IdentityUpdated(bytes32 indexed networkId, bytes metaStealthAddress);
    event IdentityRemoved(bytes32 indexed networkId);

    error InvalidMetaStealthAddressLength();
    error AlreadyRegistered(bytes32 networkId);
    error NotRegistered(bytes32 networkId);

    /// @param semaphore The Semaphore deployment holding the approved-member group.
    /// @param networkMemberGroupId The approved-member group to gate writes on.
    constructor(ISemaphore semaphore, uint256 networkMemberGroupId) NetworkMemberGate(semaphore, networkMemberGroupId) {
        UPDATE_DOMAIN_SEPARATOR = keccak256(abi.encode(UPDATE_MESSAGE_DOMAIN, address(this)));
    }

    /// @notice Registers a networkId alongside its meta-stealth address, on an approved member's
    /// authority.
    /// @param networkId The identity being registered.
    /// @param metaStealthAddress The ERC-6538 meta-stealth address to resolve to.
    /// @param proof Membership proof bound to this exact registration.
    function registerIdentity(bytes32 networkId, bytes calldata metaStealthAddress, NetworkMemberProof calldata proof)
        external
        onlyNetworkMember(_updateMessage(UpdateAction.Register, networkId, metaStealthAddress), proof)
    {
        if (identity[networkId].length != 0) revert AlreadyRegistered(networkId);

        identity[networkId] = metaStealthAddress;
        emit IdentityRegistered(networkId, metaStealthAddress);
    }

    /// @notice Repoints an existing networkId at a new meta-stealth address, on an approved member's
    /// authority.
    /// @param networkId The identity being updated.
    /// @param newMetaStealthAddress The ERC-6538 meta-stealth address to resolve to.
    /// @param proof Membership proof bound to this exact update.
    function updateIdentity(bytes32 networkId, bytes calldata newMetaStealthAddress, NetworkMemberProof calldata proof)
        external
        onlyNetworkMember(_updateMessage(UpdateAction.Update, networkId, newMetaStealthAddress), proof)
    {
        if (identity[networkId].length == 0) revert NotRegistered(networkId);

        identity[networkId] = newMetaStealthAddress;
        emit IdentityUpdated(networkId, newMetaStealthAddress);
    }

    /// @notice Clears a networkId entry, on an approved member's authority.
    /// @param networkId The identity being removed.
    /// @param proof Membership proof bound to this exact removal.
    function removeIdentity(bytes32 networkId, NetworkMemberProof calldata proof)
        external
        onlyNetworkMember(_updateMessage(UpdateAction.Remove, networkId, ""), proof)
    {
        if (identity[networkId].length == 0) revert NotRegistered(networkId);

        delete identity[networkId];
        emit IdentityRemoved(networkId);
    }

    /// @dev The Semaphore message binding a proof to one update of this registry: the payload, plus
    /// the chain id.
    ///
    /// The payload is what stops a proof authorising a different update. The domain separator and
    /// the chain id place that update at one registry on one chain. Both are load-bearing, because
    /// this contract does not own its group: two registries can be pointed at the same group id, and
    /// the same registry can be deployed to the same address on two chains with the same members
    /// admitted in the same order, which gives the same root. Without the separator a proof meant
    /// for one of them would authorise the other.
    ///
    /// The meta-stealth address is the only variable-length field and it comes last, so the packed
    /// encoding is unambiguous. Rejects a malformed meta-stealth address here, before the proof is
    /// verified, so a length mistake does not read as a bad proof.
    /// @param action Which mutation the proof authorises.
    /// @param networkId The identity being written.
    /// @param metaStealthAddress The meta-stealth address being written, empty for a removal.
    function _updateMessage(UpdateAction action, bytes32 networkId, bytes memory metaStealthAddress)
        private
        view
        returns (uint256)
    {
        if (action != UpdateAction.Remove && metaStealthAddress.length != META_STEALTH_ADDRESS_LENGTH) {
            revert InvalidMetaStealthAddressLength();
        }

        return uint256(
            keccak256(abi.encodePacked(UPDATE_DOMAIN_SEPARATOR, block.chainid, action, networkId, metaStealthAddress))
        );
    }
}
