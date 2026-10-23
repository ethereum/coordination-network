// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";
import { SafeProxy } from "@safe-global/safe-smart-account/contracts/proxies/SafeProxy.sol";
import { SafeProxyFactory } from "@safe-global/safe-smart-account/contracts/proxies/SafeProxyFactory.sol";

import { DeployBase } from "./base/DeployBase.sol";
import { DeployedThirdPartyContracts } from "./libraries/DeployedThirdPartyContracts.sol";

contract DeploySafe is DeployBase {
    uint256 public constant SALT_NONCE = uint256(keccak256("coordination-network.GovernanceSafe.V1.1"));

    error NoOwners();

    function run() external returns (Safe governanceSafe) {
        address[] memory owners = new address[](1);
        owners[0] = vm.envAddress("OWNER");

        return deploySafe(owners);
    }

    function deploySafe(address[] memory owners) public returns (Safe governanceSafe) {
        if (owners.length == 0) revert NoOwners();
        uint256 threshold = owners.length / 2 + 1;

        SafeProxyFactory safeProxyFactory = SafeProxyFactory(DeployedThirdPartyContracts.SAFE_PROXY_FACTORY);
        bytes memory initializer = abi.encodeCall(
            Safe.setup,
            (
                owners,
                threshold,
                address(0),
                "",
                DeployedThirdPartyContracts.SAFE_COMPATIBILITY_FALLBACK_HANDLER,
                address(0),
                0,
                payable(address(0))
            )
        );
        bytes32 salt = keccak256(abi.encodePacked(keccak256(initializer), SALT_NONCE));
        bytes memory proxyInitCode = abi.encodePacked(
            safeProxyFactory.proxyCreationCode(), uint256(uint160(DeployedThirdPartyContracts.SAFE_SINGLETON))
        );
        address existingAddress = vm.computeCreate2Address(salt, keccak256(proxyInitCode), address(safeProxyFactory));
        if (existingAddress.code.length != 0) return Safe(payable(existingAddress));

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        SafeProxy safeProxy = safeProxyFactory.createProxyWithNonce(
            DeployedThirdPartyContracts.SAFE_SINGLETON, initializer, SALT_NONCE
        );
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        governanceSafe = Safe(payable(address(safeProxy)));

        console.log("Safe", address(governanceSafe));
        console.log("owners", owners.length);
        console.log("threshold", threshold);
    }
}
