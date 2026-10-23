// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { DeployCredentialRevocationRegistry } from "../../script/DeployCredentialRevocationRegistry.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { CredentialRevocationRegistry } from "../../src/CredentialRevocationRegistry.sol";
import { IRevocation } from "../../src/revocation/interfaces/IRevocation.sol";
import { Revocation } from "../../src/revocation/Revocation.sol";
import { CanonicalDependencies } from "../utils/CanonicalDependencies.sol";

contract DeployCredentialRevocationRegistryUnitTest is CanonicalDependencies {
    uint256 internal constant NETWORK_MEMBER_GROUP_ID = 1;

    DeployCredentialRevocationRegistry internal deployCredentialRevocationRegistryScript;
    ISemaphore internal semaphore;
    IRevocation internal revocation;

    function setUp() public {
        deployCredentialRevocationRegistryScript = new DeployCredentialRevocationRegistry();
        semaphore = ISemaphore(DeployedThirdPartyContracts.SEMAPHORE);
        revocation = IRevocation(address(new Revocation()));
    }

    function test_deployCredentialRevocationRegistry_deploysCredentialRevocationRegistry() public {
        bytes memory initCode = abi.encodePacked(
            type(CredentialRevocationRegistry).creationCode, abi.encode(semaphore, NETWORK_MEMBER_GROUP_ID, revocation)
        );

        CredentialRevocationRegistry credentialRevocationRegistry =
            deployCredentialRevocationRegistryScript.deployCredentialRevocationRegistry(
                semaphore, NETWORK_MEMBER_GROUP_ID, revocation
            );

        assertEq(
            address(credentialRevocationRegistry),
            vm.computeCreate2Address(deployCredentialRevocationRegistryScript.SALT(), keccak256(initCode))
        );
    }
}
