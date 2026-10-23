// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script, console } from "forge-std/Script.sol";

import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";

contract AddPaymasterMember is Script {
    function run() external {
        SemaphorePaymaster semaphorePaymaster = SemaphorePaymaster(payable(vm.envAddress("SEMAPHORE_PAYMASTER")));
        uint256 networkMemberCommitment = vm.envUint("NETWORK_MEMBER_COMMITMENT");

        addPaymasterMember(semaphorePaymaster, networkMemberCommitment);
    }

    function addPaymasterMember(SemaphorePaymaster semaphorePaymaster, uint256 networkMemberCommitment) public {
        uint256 paymasterGroupId = semaphorePaymaster.GROUP_ID();
        if (semaphorePaymaster.hasMember(paymasterGroupId, networkMemberCommitment)) return;

        vm.broadcast(semaphorePaymaster.getGroupAdmin(paymasterGroupId));
        semaphorePaymaster.addMember(paymasterGroupId, networkMemberCommitment);

        console.log("added paymaster member commitment", networkMemberCommitment);
    }
}
