// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeployApprovedIssuerSet } from "../../script/DeployApprovedIssuerSet.s.sol";
import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract DeployApprovedIssuerSetUnitTest is NetworkMemberRegistryTestBase {
    function test_deployApprovedIssuerSet_deploysApprovedIssuerSet() public {
        DeployApprovedIssuerSet deployApprovedIssuerSetScript = new DeployApprovedIssuerSet();
        NetworkMemberRegistry networkMemberRegistry = new NetworkMemberRegistry(makeAddr("governance"));
        bytes memory initCode =
            abi.encodePacked(type(ApprovedIssuerSet).creationCode, abi.encode(address(networkMemberRegistry)));

        ApprovedIssuerSet approvedIssuerSet =
            deployApprovedIssuerSetScript.deployApprovedIssuerSet(address(networkMemberRegistry));

        assertEq(
            address(approvedIssuerSet),
            vm.computeCreate2Address(deployApprovedIssuerSetScript.SALT(), keccak256(initCode))
        );
    }
}
