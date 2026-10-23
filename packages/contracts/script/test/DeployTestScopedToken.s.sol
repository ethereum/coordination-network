// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { TestScopedToken } from "../../test/utils/TestScopedToken.sol";
import { DeployBase } from "../base/DeployBase.sol";

contract DeployTestScopedToken is DeployBase {
    bytes32 public constant SALT = keccak256("coordination-network.TestScopedToken.V1.1");

    function run() external returns (TestScopedToken token) {
        return deployTestScopedToken();
    }

    function deployTestScopedToken() public returns (TestScopedToken token) {
        address existingAddress = alreadyDeployedAt(SALT, type(TestScopedToken).creationCode);
        if (existingAddress != address(0)) return TestScopedToken(existingAddress);

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        token = new TestScopedToken{ salt: SALT }();
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("TestScopedToken", address(token));
    }
}
