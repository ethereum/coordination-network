// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script, console } from "forge-std/Script.sol";

import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";

/// @dev Takes the unspent deposit and starts the stake's unstake delay.
contract WithdrawPaymasterDeposit is Script {
    function run() external returns (uint256 withdrawnDeposit) {
        SemaphorePaymaster paymaster = SemaphorePaymaster(payable(vm.envAddress("SEMAPHORE_PAYMASTER")));
        address payable withdrawTo = payable(vm.envAddress("PAYMASTER_WITHDRAW_TO"));
        return withdrawPaymasterDeposit(paymaster, withdrawTo);
    }

    function withdrawPaymasterDeposit(SemaphorePaymaster paymaster, address payable withdrawTo)
        public
        returns (uint256 withdrawnDeposit)
    {
        withdrawnDeposit = paymaster.getDeposit();

        vm.startBroadcast(paymaster.owner());
        paymaster.withdrawTo(withdrawTo, withdrawnDeposit);
        paymaster.unlockStake();
        vm.stopBroadcast();

        console.log("withdrawn deposit", withdrawnDeposit);
        console.log("withdrawn to", withdrawTo);
    }
}
