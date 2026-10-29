// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { NetworkMemberGroup } from "../src/NetworkMemberGroup.sol";
import { DeployBase } from "./base/DeployBase.sol";
import { DeployedThirdPartyContracts } from "./libraries/DeployedThirdPartyContracts.sol";

contract DeployNetworkMemberGroup is DeployBase {
    bytes32 public constant SALT = keccak256("coordination-network.NetworkMemberGroup.V1.1");

    function run() external returns (NetworkMemberGroup group) {
        address governanceSafe = vm.envAddress("GOVERNANCE_SAFE");
        return deployNetworkMemberGroup(governanceSafe, ISemaphore(DeployedThirdPartyContracts.SEMAPHORE));
    }

    function deployNetworkMemberGroup(address safe, ISemaphore semaphore) public returns (NetworkMemberGroup group) {
        bytes memory initCode = abi.encodePacked(type(NetworkMemberGroup).creationCode, abi.encode(semaphore, safe));
        address existingAddress = alreadyDeployedAt(SALT, initCode);
        if (existingAddress != address(0)) return NetworkMemberGroup(existingAddress);

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        group = new NetworkMemberGroup{ salt: SALT }(semaphore, safe);
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("NetworkMemberGroup", address(group));
        console.log("approved-network-member group id", group.GROUP_ID());
    }
}
