// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { ApprovedIssuerSet } from "../src/ApprovedIssuerSet.sol";
import { DeployBase } from "./base/DeployBase.sol";

contract DeployApprovedIssuerSet is DeployBase {
    bytes32 public constant SALT = keccak256("coordination-network.ApprovedIssuerSet.V1.1");

    function run() external returns (ApprovedIssuerSet issuerSet) {
        address networkMemberRegistry = vm.envAddress("NETWORK_MEMBER_REGISTRY");
        return deployApprovedIssuerSet(networkMemberRegistry);
    }

    function deployApprovedIssuerSet(address memberRegistry) public returns (ApprovedIssuerSet issuerSet) {
        bytes memory initCode = abi.encodePacked(type(ApprovedIssuerSet).creationCode, abi.encode(memberRegistry));
        address existingAddress = alreadyDeployedAt(SALT, initCode);
        if (existingAddress != address(0)) return ApprovedIssuerSet(existingAddress);

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        issuerSet = new ApprovedIssuerSet{ salt: SALT }(memberRegistry);
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("ApprovedIssuerSet", address(issuerSet));
    }
}
