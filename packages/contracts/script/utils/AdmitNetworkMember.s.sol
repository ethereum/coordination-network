// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";

import { NetworkMemberGovernance } from "../../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { SafeTransaction } from "../base/SafeTransaction.sol";

/// @notice Admits one network member: its registry record, its group leaf and its Safe signer. The
/// founding member already owns the Safe from creation, so it gets only the record and the leaf.
contract AdmitNetworkMember is SafeTransaction {
    function run() external {
        Safe governanceSafe = Safe(payable(vm.envAddress("GOVERNANCE_SAFE")));
        address owner = vm.envAddress("OWNER");
        NetworkMemberGovernance networkMemberGovernance =
            NetworkMemberGovernance(vm.envAddress("NETWORK_MEMBER_GOVERNANCE"));
        bytes memory accountKey = vm.envBytes("MEMBER_ACCOUNT_PUBLIC_KEY");
        require(accountKey.length == 64, "MEMBER_ACCOUNT_PUBLIC_KEY must be 64 bytes: X || Y");
        (uint256 accountKeyX, uint256 accountKeyY) = abi.decode(accountKey, (uint256, uint256));
        uint256 networkMemberCommitment = vm.envUint("NETWORK_MEMBER_COMMITMENT");
        address networkMemberMultisigSigner = vm.envAddress("NETWORK_MEMBER_MULTISIG_SIGNER");

        admitNetworkMember(
            governanceSafe,
            owner,
            networkMemberGovernance,
            accountKeyX,
            accountKeyY,
            networkMemberCommitment,
            networkMemberMultisigSigner
        );
    }

    function admitNetworkMember(
        Safe governanceSafe,
        address owner,
        NetworkMemberGovernance networkMemberGovernance,
        uint256 accountKeyX,
        uint256 accountKeyY,
        uint256 networkMemberCommitment,
        address networkMemberMultisigSigner
    ) public {
        if (governanceSafe.isOwner(networkMemberMultisigSigner)) {
            admitExistingSafeOwner(
                governanceSafe,
                owner,
                networkMemberGovernance,
                accountKeyX,
                accountKeyY,
                networkMemberCommitment,
                networkMemberMultisigSigner
            );
        } else {
            addNewNetworkMember(
                governanceSafe,
                owner,
                networkMemberGovernance,
                accountKeyX,
                accountKeyY,
                networkMemberCommitment,
                networkMemberMultisigSigner
            );
        }
    }

    /// @dev Calls `NetworkMemberGovernance.admitMember()`, which admits a member in full: its registry
    /// identity, its Semaphore leaf and its Safe signer.
    function addNewNetworkMember(
        Safe governanceSafe,
        address owner,
        NetworkMemberGovernance networkMemberGovernance,
        uint256 accountKeyX,
        uint256 accountKeyY,
        uint256 networkMemberCommitment,
        address networkMemberMultisigSigner
    ) internal {
        bytes memory admission = abi.encodeCall(
            NetworkMemberGovernance.admitMember,
            (
                accountKeyX,
                accountKeyY,
                networkMemberCommitment,
                networkMemberMultisigSigner,
                governanceSafe.getOwners().length
            )
        );

        execFromSafe(governanceSafe, owner, address(networkMemberGovernance), admission);

        console.log("admitted network member commitment", networkMemberCommitment);
        console.log("Network member Safe signer", networkMemberMultisigSigner);
    }

    /// @dev Bypasses `NetworkMemberGovernance.admitMember()`, because the member's signer is already an
    /// owner on the Safe. Adds only its registry identity and Semaphore leaf.
    function admitExistingSafeOwner(
        Safe governanceSafe,
        address owner,
        NetworkMemberGovernance networkMemberGovernance,
        uint256 accountKeyX,
        uint256 accountKeyY,
        uint256 networkMemberCommitment,
        address networkMemberMultisigSigner
    ) internal {
        NetworkMemberRegistry networkMemberRegistry = networkMemberGovernance.REGISTRY();
        NetworkMemberGroup networkMemberGroup = networkMemberGovernance.GROUP();
        bool isApproved =
            networkMemberRegistry.isApproved(networkMemberRegistry.memberNetworkIdOf(accountKeyX, accountKeyY));
        bool isInGroup = networkMemberGroup.hasNetworkMember(networkMemberCommitment);

        if (isApproved && isInGroup) return;

        if (!isApproved) {
            execFromSafe(
                governanceSafe,
                owner,
                address(networkMemberRegistry),
                abi.encodeCall(
                    NetworkMemberRegistry.approveNetworkMember,
                    (accountKeyX, accountKeyY, networkMemberCommitment, networkMemberMultisigSigner)
                )
            );
        }

        if (!isInGroup) {
            execFromSafe(
                governanceSafe,
                owner,
                address(networkMemberGroup),
                abi.encodeCall(NetworkMemberGroup.addNetworkMember, (networkMemberCommitment))
            );
        }

        console.log("admitted network member commitment", networkMemberCommitment);
        console.log("Network member Safe signer", networkMemberMultisigSigner);
    }
}
