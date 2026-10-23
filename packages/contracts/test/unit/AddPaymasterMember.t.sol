// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeploySemaphorePaymaster } from "../../script/DeploySemaphorePaymaster.s.sol";
import { AddPaymasterMember } from "../../script/utils/AddPaymasterMember.s.sol";
import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";
import { TestBase } from "../utils/TestBase.sol";

contract AddPaymasterMemberUnitTest is TestBase {
    uint256 internal constant NETWORK_MEMBER_COMMITMENT = 12_345;

    AddPaymasterMember internal addPaymasterMemberScript;
    SemaphorePaymaster internal semaphorePaymaster;

    function setUp() public {
        semaphorePaymaster = new DeploySemaphorePaymaster().deploySemaphorePaymaster(DEFAULT_SENDER, 0.05 ether);
        addPaymasterMemberScript = new AddPaymasterMember();
    }

    function test_addPaymasterMember_reRunChangesNothing() public {
        addPaymasterMemberScript.addPaymasterMember(semaphorePaymaster, NETWORK_MEMBER_COMMITMENT);

        addPaymasterMemberScript.addPaymasterMember(semaphorePaymaster, NETWORK_MEMBER_COMMITMENT);

        assertEq(semaphorePaymaster.getMerkleTreeSize(semaphorePaymaster.GROUP_ID()), 1);
    }

    function test_addPaymasterMember_addsTheCommitmentToThePaymasterGroup() public {
        addPaymasterMemberScript.addPaymasterMember(semaphorePaymaster, NETWORK_MEMBER_COMMITMENT);

        assertTrue(semaphorePaymaster.hasMember(semaphorePaymaster.GROUP_ID(), NETWORK_MEMBER_COMMITMENT));
    }
}
