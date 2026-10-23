// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script } from "forge-std/Script.sol";

import { Enum } from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";
import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";

abstract contract SafeTransaction is Script {
    error NotASafeOwner(address owner);
    error NotEnoughApprovals(uint256 approvals, uint256 threshold);

    /// @dev Executes one call from the Safe, sent by `owner` and counting every other owner that
    /// has already approved the same transaction on chain. A Safe accepts both as
    /// signatures when the entry names the owner and its type byte is 1, so nothing is signed
    /// offline. Short of the threshold, the call is refused here rather than inside the Safe.
    function execFromSafe(Safe governanceSafe, address owner, address to, bytes memory data) internal {
        bytes32 transactionHash = governanceSafe.getTransactionHash(
            to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), address(0), governanceSafe.nonce()
        );
        bytes memory signatures = _collectApprovals(governanceSafe, owner, transactionHash);

        vm.broadcast(owner);
        governanceSafe.execTransaction(
            to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), payable(address(0)), signatures
        );
    }

    function _collectApprovals(Safe governanceSafe, address owner, bytes32 transactionHash)
        private
        view
        returns (bytes memory)
    {
        if (!governanceSafe.isOwner(owner)) revert NotASafeOwner(owner);

        address[] memory owners = _ownersByAscendingAddress(governanceSafe);
        bytes memory signatures;
        uint256 approvals;
        for (uint256 i = 0; i < owners.length; ++i) {
            bool hasApproved = owners[i] == owner || governanceSafe.approvedHashes(owners[i], transactionHash) == 1;
            if (!hasApproved) continue;

            signatures = abi.encodePacked(signatures, bytes32(uint256(uint160(owners[i]))), bytes32(0), uint8(1));
            approvals += 1;
        }

        uint256 threshold = governanceSafe.getThreshold();
        if (approvals < threshold) revert NotEnoughApprovals(approvals, threshold);

        return signatures;
    }

    function _ownersByAscendingAddress(Safe governanceSafe) private view returns (address[] memory owners) {
        owners = governanceSafe.getOwners();
        for (uint256 i = 0; i < owners.length; ++i) {
            for (uint256 j = i + 1; j < owners.length; ++j) {
                if (owners[j] < owners[i]) (owners[i], owners[j]) = (owners[j], owners[i]);
            }
        }
    }
}
