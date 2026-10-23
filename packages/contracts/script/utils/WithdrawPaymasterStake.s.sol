// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script, console } from "forge-std/Script.sol";

import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";

/// @dev Run after WithdrawPaymasterDeposit, once the unstake delay it started has passed.
contract WithdrawPaymasterStake is Script {
    function run() external {
        SemaphorePaymaster paymaster = SemaphorePaymaster(payable(vm.envAddress("SEMAPHORE_PAYMASTER")));
        address payable withdrawTo = payable(vm.envAddress("PAYMASTER_WITHDRAW_TO"));
        withdrawPaymasterStake(paymaster, withdrawTo);
    }

    function withdrawPaymasterStake(SemaphorePaymaster paymaster, address payable withdrawTo) public {
        vm.broadcast(paymaster.owner());
        paymaster.withdrawStake(withdrawTo);

        console.log("withdrawn stake to", withdrawTo);
    }
}
