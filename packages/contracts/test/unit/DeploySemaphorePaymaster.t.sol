// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeploySemaphorePaymaster } from "../../script/DeploySemaphorePaymaster.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";
import { TestBase } from "../utils/TestBase.sol";

contract DeploySemaphorePaymasterUnitTest is TestBase {
    uint256 internal constant MAX_COST_PER_OP = 0.05 ether;

    function test_deploySemaphorePaymaster_deploysSemaphorePaymaster() public {
        DeploySemaphorePaymaster deploySemaphorePaymasterScript = new DeploySemaphorePaymaster();
        address paymasterOwner = makeAddr("paymasterOwner");
        bytes memory initCode = abi.encodePacked(
            type(SemaphorePaymaster).creationCode,
            abi.encode(
                DeployedThirdPartyContracts.ENTRY_POINT,
                DeployedThirdPartyContracts.SEMAPHORE_VERIFIER,
                paymasterOwner,
                MAX_COST_PER_OP
            )
        );

        SemaphorePaymaster semaphorePaymaster =
            deploySemaphorePaymasterScript.deploySemaphorePaymaster(paymasterOwner, MAX_COST_PER_OP);

        assertEq(
            address(semaphorePaymaster),
            vm.computeCreate2Address(deploySemaphorePaymasterScript.SALT(), keccak256(initCode))
        );
    }
}
