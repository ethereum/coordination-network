// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { IStakeManager } from "@account-abstraction/contracts/interfaces/IStakeManager.sol";

import { DeploySemaphorePaymaster } from "../../script/DeploySemaphorePaymaster.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { FundPaymaster } from "../../script/utils/FundPaymaster.s.sol";
import { WithdrawPaymasterDeposit } from "../../script/utils/WithdrawPaymasterDeposit.s.sol";
import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";
import { TestBase } from "../utils/TestBase.sol";

contract WithdrawPaymasterDepositUnitTest is TestBase {
    WithdrawPaymasterDeposit internal withdrawPaymasterDepositScript;
    SemaphorePaymaster internal semaphorePaymaster;

    address payable internal withdrawTo;

    uint256 internal constant PAYMASTER_DEPOSIT = 0.2 ether;
    uint256 internal constant PAYMASTER_STAKE = 1 ether;
    uint32 internal constant UNSTAKE_DELAY_SECONDS = 1 days;

    function setUp() public {
        semaphorePaymaster = new DeploySemaphorePaymaster().deploySemaphorePaymaster(DEFAULT_SENDER, 0.05 ether);
        withdrawTo = payable(makeAddr("withdrawTo"));
        vm.deal(DEFAULT_SENDER, 10 ether);

        withdrawPaymasterDepositScript = new WithdrawPaymasterDeposit();
        new FundPaymaster().fundPaymaster(semaphorePaymaster, PAYMASTER_DEPOSIT, PAYMASTER_STAKE, UNSTAKE_DELAY_SECONDS);
    }

    function test_withdrawPaymasterDeposit_returnsTheDepositAndUnlocksTheStake() public {
        uint256 withdrawnDeposit =
            withdrawPaymasterDepositScript.withdrawPaymasterDeposit(semaphorePaymaster, withdrawTo);

        assertEq(withdrawnDeposit, PAYMASTER_DEPOSIT);
        assertEq(withdrawTo.balance, PAYMASTER_DEPOSIT);
        assertEq(semaphorePaymaster.getDeposit(), 0);

        IStakeManager.DepositInfo memory depositInfo =
            IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT).getDepositInfo(address(semaphorePaymaster));
        assertFalse(depositInfo.staked);
        assertEq(depositInfo.stake, PAYMASTER_STAKE);
    }
}
