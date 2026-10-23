// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeployRevocation } from "../../script/DeployRevocation.s.sol";
import { CreateRevocationRegistry } from "../../script/utils/CreateRevocationRegistry.s.sol";
import { Revocation } from "../../src/revocation/Revocation.sol";
import { CanonicalDependencies } from "../utils/CanonicalDependencies.sol";

contract CreateRevocationRegistryUnitTest is CanonicalDependencies {
    function test_createRevocationRegistry_createsOneRegistryUnderTheGivenAdmin() public {
        Revocation revocation = new DeployRevocation().deployRevocation();
        address revocationAdmin = makeAddr("revocationAdmin");

        uint256 revocationRegistryId =
            new CreateRevocationRegistry().createRevocationRegistry(revocation, revocationAdmin);

        assertEq(revocation.getRegistryAdmin(revocationRegistryId), revocationAdmin);
        assertEq(revocation.registryCounter(), 1);
    }
}
