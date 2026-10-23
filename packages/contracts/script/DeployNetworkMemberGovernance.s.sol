// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { NetworkMemberGovernance } from "../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../src/NetworkMemberRegistry.sol";
import { ISafeGovernance } from "../src/interfaces/ISafeGovernance.sol";
import { DeployBase } from "./base/DeployBase.sol";

contract DeployNetworkMemberGovernance is DeployBase {
    bytes32 public constant SALT = keccak256("coordination-network.NetworkMemberGovernance.V1.1");

    function run() external returns (NetworkMemberGovernance governance) {
        address governanceSafe = vm.envAddress("GOVERNANCE_SAFE");
        NetworkMemberRegistry networkMemberRegistry = NetworkMemberRegistry(vm.envAddress("NETWORK_MEMBER_REGISTRY"));
        NetworkMemberGroup networkMemberGroup = NetworkMemberGroup(vm.envAddress("NETWORK_MEMBER_GROUP"));
        return deployNetworkMemberGovernance(governanceSafe, networkMemberRegistry, networkMemberGroup);
    }

    function deployNetworkMemberGovernance(address safe, NetworkMemberRegistry registry, NetworkMemberGroup group)
        public
        returns (NetworkMemberGovernance governance)
    {
        bytes memory initCode = abi.encodePacked(
            type(NetworkMemberGovernance).creationCode, abi.encode(ISafeGovernance(safe), registry, group)
        );
        address existingAddress = alreadyDeployedAt(SALT, initCode);
        if (existingAddress != address(0)) return NetworkMemberGovernance(existingAddress);

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        governance = new NetworkMemberGovernance{ salt: SALT }(ISafeGovernance(safe), registry, group);
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("NetworkMemberGovernance", address(governance));
    }
}
