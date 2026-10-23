// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script, console } from "forge-std/Script.sol";

import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";

contract FundPaymaster is Script {
    error ZeroDeposit();
    error ZeroStake();
    error ZeroUnstakeDelay();

    function run() external returns (uint256 depositAfter) {
        SemaphorePaymaster semaphorePaymaster = SemaphorePaymaster(payable(vm.envAddress("SEMAPHORE_PAYMASTER")));
        uint256 depositAmount = vm.envUint("PAYMASTER_DEPOSIT");
        uint256 stakeAmount = vm.envUint("PAYMASTER_STAKE");
        uint32 unstakeDelaySeconds = uint32(vm.envUint("PAYMASTER_UNSTAKE_DELAY"));

        return fundPaymaster(semaphorePaymaster, depositAmount, stakeAmount, unstakeDelaySeconds);
    }

    function fundPaymaster(
        SemaphorePaymaster semaphorePaymaster,
        uint256 depositAmount,
        uint256 stakeAmount,
        uint32 unstakeDelaySeconds
    ) public returns (uint256 depositAfter) {
        if (depositAmount == 0) revert ZeroDeposit();
        if (stakeAmount == 0) revert ZeroStake();
        if (unstakeDelaySeconds == 0) revert ZeroUnstakeDelay();

        vm.startBroadcast(semaphorePaymaster.owner());
        semaphorePaymaster.deposit{ value: depositAmount }();
        semaphorePaymaster.addStake{ value: stakeAmount }(unstakeDelaySeconds);
        vm.stopBroadcast();

        depositAfter = semaphorePaymaster.getDeposit();
        console.log("SemaphorePaymaster", address(semaphorePaymaster));
        console.log("deposit", depositAfter);
        console.log("staked", stakeAmount);
        console.log("unstake delay in seconds", unstakeDelaySeconds);
    }
}
