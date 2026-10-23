// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script } from "forge-std/Script.sol";

abstract contract DeployBase is Script {
    /// @notice What deploying contracts cost in gas in total
    uint256 public deploymentGas;

    function alreadyDeployedAt(bytes32 salt, bytes memory initCode) internal view returns (address) {
        address saltedAddress = vm.computeCreate2Address(salt, keccak256(initCode));
        return saltedAddress.code.length == 0 ? address(0) : saltedAddress;
    }
}
