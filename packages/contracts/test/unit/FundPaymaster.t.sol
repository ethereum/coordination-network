// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { IStakeManager } from "@account-abstraction/contracts/interfaces/IStakeManager.sol";

import { DeploySemaphorePaymaster } from "../../script/DeploySemaphorePaymaster.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { FundPaymaster } from "../../script/utils/FundPaymaster.s.sol";
import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";
import { TestBase } from "../utils/TestBase.sol";

contract FundPaymasterUnitTest is TestBase {
    FundPaymaster internal fundPaymasterScript;
    SemaphorePaymaster internal semaphorePaymaster;

    uint256 internal constant DEPOSIT = 0.2 ether;
    uint256 internal constant STAKE = 1 ether;
    uint32 internal constant UNSTAKE_DELAY_SECONDS = 1 days;

    function setUp() public {
        semaphorePaymaster = new DeploySemaphorePaymaster().deploySemaphorePaymaster(DEFAULT_SENDER, 0.05 ether);
        fundPaymasterScript = new FundPaymaster();
        vm.deal(DEFAULT_SENDER, 10 ether);
    }

    function test_fundPaymaster_leavesTheDepositAndStakeOnThePaymaster() public {
        uint256 depositAfter =
            fundPaymasterScript.fundPaymaster(semaphorePaymaster, DEPOSIT, STAKE, UNSTAKE_DELAY_SECONDS);

        assertEq(depositAfter, DEPOSIT);
        assertEq(semaphorePaymaster.getDeposit(), DEPOSIT);

        IStakeManager.DepositInfo memory info =
            IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT).getDepositInfo(address(semaphorePaymaster));
        assertEq(info.stake, STAKE);
        assertTrue(info.staked);
    }

    function test_fundPaymaster_stakesForTheDelayItWasGiven() public {
        fundPaymasterScript.fundPaymaster(semaphorePaymaster, DEPOSIT, STAKE, UNSTAKE_DELAY_SECONDS);

        IStakeManager.DepositInfo memory info =
            IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT).getDepositInfo(address(semaphorePaymaster));
        assertEq(info.unstakeDelaySec, UNSTAKE_DELAY_SECONDS);
    }

    function test_fundPaymaster_revertsWhenTheDepositIsZero() public {
        vm.expectRevert(FundPaymaster.ZeroDeposit.selector);
        fundPaymasterScript.fundPaymaster(semaphorePaymaster, 0, STAKE, UNSTAKE_DELAY_SECONDS);
    }

    function test_fundPaymaster_revertsWhenTheStakeIsZero() public {
        vm.expectRevert(FundPaymaster.ZeroStake.selector);
        fundPaymasterScript.fundPaymaster(semaphorePaymaster, DEPOSIT, 0, UNSTAKE_DELAY_SECONDS);
    }

    function test_fundPaymaster_revertsWhenTheStakeCouldBeWithdrawnImmediately() public {
        vm.expectRevert(FundPaymaster.ZeroUnstakeDelay.selector);
        fundPaymasterScript.fundPaymaster(semaphorePaymaster, DEPOSIT, STAKE, 0);
    }

    function test_fundPaymaster_aSecondRunAddsMoreFunds() public {
        fundPaymasterScript.fundPaymaster(semaphorePaymaster, DEPOSIT, STAKE, UNSTAKE_DELAY_SECONDS);

        assertEq(
            fundPaymasterScript.fundPaymaster(semaphorePaymaster, DEPOSIT, STAKE, UNSTAKE_DELAY_SECONDS), DEPOSIT * 2
        );
    }
}
