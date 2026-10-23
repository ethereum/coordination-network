// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeployRevocation } from "../../script/DeployRevocation.s.sol";
import { Revocation } from "../../src/revocation/Revocation.sol";
import { CanonicalDependencies } from "../utils/CanonicalDependencies.sol";

contract DeployRevocationUnitTest is CanonicalDependencies {
    function test_deployRevocation_deploysRevocation() public {
        DeployRevocation deployRevocationScript = new DeployRevocation();

        Revocation revocation = deployRevocationScript.deployRevocation();

        assertEq(
            address(revocation),
            vm.computeCreate2Address(deployRevocationScript.SALT(), keccak256(type(Revocation).creationCode))
        );
    }
}
