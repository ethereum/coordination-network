// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { IdentityRegistry } from "../src/IdentityRegistry.sol";
import { DeployBase } from "./base/DeployBase.sol";
import { DeployedThirdPartyContracts } from "./libraries/DeployedThirdPartyContracts.sol";

contract DeployIdentityRegistry is DeployBase {
    bytes32 public constant SALT = keccak256("coordination-network.IdentityRegistry.V1.1");

    function run() external returns (IdentityRegistry registry) {
        uint256 networkMemberGroupId = vm.envUint("NETWORK_MEMBER_GROUP_ID");
        return deployIdentityRegistry(ISemaphore(DeployedThirdPartyContracts.SEMAPHORE), networkMemberGroupId);
    }

    function deployIdentityRegistry(ISemaphore semaphore, uint256 networkMemberGroupId)
        public
        returns (IdentityRegistry registry)
    {
        bytes memory initCode =
            abi.encodePacked(type(IdentityRegistry).creationCode, abi.encode(semaphore, networkMemberGroupId));
        address existingAddress = alreadyDeployedAt(SALT, initCode);
        if (existingAddress != address(0)) return IdentityRegistry(existingAddress);

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        registry = new IdentityRegistry{ salt: SALT }(semaphore, networkMemberGroupId);
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("IdentityRegistry", address(registry));
    }
}
