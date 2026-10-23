// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { NetworkMemberRegistry } from "../src/NetworkMemberRegistry.sol";
import { DeployBase } from "./base/DeployBase.sol";

interface ISafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

contract DeployNetworkMemberRegistry is DeployBase {
    uint256 public constant MIN_OWNERS = 1;

    bytes32 public constant SALT = keccak256("coordination-network.NetworkMemberRegistry.V1.1");

    error GovernanceIsNotAContract(address governance);
    error GovernanceThresholdIsNotMajority(uint256 threshold, uint256 expected);
    error GovernanceOwnerSetTooSmall(uint256 ownerCount);

    function governanceThreshold(uint256 memberCount) public pure returns (uint256) {
        return memberCount / 2 + 1;
    }

    function run() external returns (NetworkMemberRegistry registry) {
        address governanceSafe = vm.envAddress("GOVERNANCE_SAFE");
        return deployNetworkMemberRegistry(governanceSafe);
    }

    function deployNetworkMemberRegistry(address safe) public returns (NetworkMemberRegistry registry) {
        _checkGovernance(safe);
        bytes memory initCode = abi.encodePacked(type(NetworkMemberRegistry).creationCode, abi.encode(safe));
        address existingAddress = alreadyDeployedAt(SALT, initCode);
        if (existingAddress != address(0)) return NetworkMemberRegistry(existingAddress);

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        registry = new NetworkMemberRegistry{ salt: SALT }(safe);
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("NetworkMemberRegistry", address(registry));
    }

    function _checkGovernance(address governance) internal view {
        if (governance.code.length == 0) revert GovernanceIsNotAContract(governance);

        uint256 ownerCount = ISafe(governance).getOwners().length;
        if (ownerCount < MIN_OWNERS) revert GovernanceOwnerSetTooSmall(ownerCount);

        uint256 threshold = ISafe(governance).getThreshold();
        uint256 expected = governanceThreshold(ownerCount);
        if (threshold != expected) revert GovernanceThresholdIsNotMajority(threshold, expected);
    }
}
