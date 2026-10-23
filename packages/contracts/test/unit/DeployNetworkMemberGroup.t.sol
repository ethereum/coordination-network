// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { DeployNetworkMemberGroup } from "../../script/DeployNetworkMemberGroup.s.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract DeployNetworkMemberGroupUnitTest is NetworkMemberRegistryTestBase {
    function test_deployNetworkMemberGroup_deploysNetworkMemberGroup() public {
        DeployNetworkMemberGroup deployNetworkMemberGroupScript = new DeployNetworkMemberGroup();
        _deployGovernanceSafe(5);
        ISemaphore semaphore = _deploySemaphore();
        bytes memory initCode =
            abi.encodePacked(type(NetworkMemberGroup).creationCode, abi.encode(semaphore, address(safe)));

        NetworkMemberGroup networkMemberGroup =
            deployNetworkMemberGroupScript.deployNetworkMemberGroup(address(safe), semaphore);

        assertEq(
            address(networkMemberGroup),
            vm.computeCreate2Address(deployNetworkMemberGroupScript.SALT(), keccak256(initCode))
        );
    }
}
