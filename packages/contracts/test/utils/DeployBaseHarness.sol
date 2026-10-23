// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeployBase } from "../../script/base/DeployBase.sol";
import { TestScopedToken } from "./TestScopedToken.sol";

contract DeployBaseHarness is DeployBase {
    function deployedAt(bytes32 salt, bytes memory initCode) external view returns (address) {
        return alreadyDeployedAt(salt, initCode);
    }

    function deploy(bytes32 salt) external returns (TestScopedToken testScopedToken) {
        vm.startBroadcast();
        testScopedToken = new TestScopedToken{ salt: salt }();
        vm.stopBroadcast();
    }
}
