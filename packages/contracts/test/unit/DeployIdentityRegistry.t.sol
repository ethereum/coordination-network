// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { DeployIdentityRegistry } from "../../script/DeployIdentityRegistry.s.sol";
import { IdentityRegistry } from "../../src/IdentityRegistry.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract DeployIdentityRegistryUnitTest is NetworkMemberRegistryTestBase {
    uint256 internal constant NETWORK_MEMBER_GROUP_ID = 1;

    function test_deployIdentityRegistry_deploysIdentityRegistry() public {
        DeployIdentityRegistry deployIdentityRegistryScript = new DeployIdentityRegistry();
        ISemaphore semaphore = _deploySemaphore();
        bytes memory initCode =
            abi.encodePacked(type(IdentityRegistry).creationCode, abi.encode(semaphore, NETWORK_MEMBER_GROUP_ID));

        IdentityRegistry identityRegistry =
            deployIdentityRegistryScript.deployIdentityRegistry(semaphore, NETWORK_MEMBER_GROUP_ID);

        assertEq(
            address(identityRegistry),
            vm.computeCreate2Address(deployIdentityRegistryScript.SALT(), keccak256(initCode))
        );
    }
}
