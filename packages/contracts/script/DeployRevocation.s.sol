// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { Revocation } from "../src/revocation/Revocation.sol";
import { DeployBase } from "./base/DeployBase.sol";

contract DeployRevocation is DeployBase {
    bytes32 public constant SALT = keccak256("coordination-network.Revocation.V1.1");

    function run() external returns (Revocation revocation) {
        return deployRevocation();
    }

    function deployRevocation() public returns (Revocation revocation) {
        address existingAddress = alreadyDeployedAt(SALT, type(Revocation).creationCode);
        if (existingAddress != address(0)) return Revocation(existingAddress);

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        revocation = new Revocation{ salt: SALT }();
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("Revocation", address(revocation));
    }
}
