// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { IStakeManager } from "@account-abstraction/contracts/interfaces/IStakeManager.sol";

import { DeploySemaphorePaymaster } from "../../script/DeploySemaphorePaymaster.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { FundPaymaster } from "../../script/utils/FundPaymaster.s.sol";
import { WithdrawPaymasterDeposit } from "../../script/utils/WithdrawPaymasterDeposit.s.sol";
import { WithdrawPaymasterStake } from "../../script/utils/WithdrawPaymasterStake.s.sol";
import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";
import { TestBase } from "../utils/TestBase.sol";

contract WithdrawPaymasterStakeUnitTest is TestBase {
    FundPaymaster internal fundPaymasterScript;
    WithdrawPaymasterDeposit internal withdrawPaymasterDepositScript;
    WithdrawPaymasterStake internal withdrawPaymasterStakeScript;
    SemaphorePaymaster internal semaphorePaymaster;

    address payable internal withdrawTo;

    uint256 internal constant PAYMASTER_DEPOSIT = 0.2 ether;
    uint256 internal constant PAYMASTER_STAKE = 1 ether;
    uint32 internal constant UNSTAKE_DELAY_SECONDS = 1 days;

    function setUp() public {
        semaphorePaymaster = new DeploySemaphorePaymaster().deploySemaphorePaymaster(DEFAULT_SENDER, 0.05 ether);
        withdrawTo = payable(makeAddr("withdrawTo"));
        vm.deal(DEFAULT_SENDER, 10 ether);

        fundPaymasterScript = new FundPaymaster();
        withdrawPaymasterDepositScript = new WithdrawPaymasterDeposit();
        withdrawPaymasterStakeScript = new WithdrawPaymasterStake();
        fundPaymasterScript.fundPaymaster(semaphorePaymaster, PAYMASTER_DEPOSIT, PAYMASTER_STAKE, UNSTAKE_DELAY_SECONDS);
    }

    function test_withdrawPaymasterStake_returnsTheStakeOnceTheDelayHasPassed() public {
        withdrawPaymasterDepositScript.withdrawPaymasterDeposit(semaphorePaymaster, withdrawTo);
        vm.warp(block.timestamp + UNSTAKE_DELAY_SECONDS);

        withdrawPaymasterStakeScript.withdrawPaymasterStake(semaphorePaymaster, withdrawTo);

        assertEq(withdrawTo.balance, PAYMASTER_DEPOSIT + PAYMASTER_STAKE);
        IStakeManager.DepositInfo memory depositInfo =
            IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT).getDepositInfo(address(semaphorePaymaster));
        assertEq(depositInfo.stake, 0);
    }

    function test_withdrawPaymasterStake_revertsWhenTheDelayIsStillRunning() public {
        withdrawPaymasterDepositScript.withdrawPaymasterDeposit(semaphorePaymaster, withdrawTo);

        vm.expectRevert("Stake withdrawal is not due");
        withdrawPaymasterStakeScript.withdrawPaymasterStake(semaphorePaymaster, withdrawTo);
    }

    function test_withdrawPaymasterStake_revertsWhenTheStakeWasNeverUnlocked() public {
        vm.expectRevert("must call unlockStake() first");
        withdrawPaymasterStakeScript.withdrawPaymasterStake(semaphorePaymaster, withdrawTo);
    }
}
