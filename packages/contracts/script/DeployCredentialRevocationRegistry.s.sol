// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { CredentialRevocationRegistry } from "../src/CredentialRevocationRegistry.sol";
import { IRevocation } from "../src/revocation/interfaces/IRevocation.sol";
import { DeployBase } from "./base/DeployBase.sol";
import { DeployedThirdPartyContracts } from "./libraries/DeployedThirdPartyContracts.sol";

contract DeployCredentialRevocationRegistry is DeployBase {
    bytes32 public constant SALT = keccak256("coordination-network.CredentialRevocationRegistry.V1.1");

    function run() external returns (CredentialRevocationRegistry credentialRevocationRegistry) {
        uint256 networkMemberGroupId = vm.envUint("NETWORK_MEMBER_GROUP_ID");
        IRevocation revocation = IRevocation(vm.envAddress("REVOCATION"));

        return deployCredentialRevocationRegistry(
            ISemaphore(DeployedThirdPartyContracts.SEMAPHORE), networkMemberGroupId, revocation
        );
    }

    function deployCredentialRevocationRegistry(
        ISemaphore semaphore,
        uint256 networkMemberGroupId,
        IRevocation revocation
    ) public returns (CredentialRevocationRegistry credentialRevocationRegistry) {
        bytes memory initCode = abi.encodePacked(
            type(CredentialRevocationRegistry).creationCode, abi.encode(semaphore, networkMemberGroupId, revocation)
        );
        address existingAddress = alreadyDeployedAt(SALT, initCode);
        if (existingAddress != address(0)) return CredentialRevocationRegistry(existingAddress);

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        credentialRevocationRegistry =
            new CredentialRevocationRegistry{ salt: SALT }(semaphore, networkMemberGroupId, revocation);
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("CredentialRevocationRegistry", address(credentialRevocationRegistry));
        console.log("revocation registry id", credentialRevocationRegistry.REGISTRY_ID());
    }
}
