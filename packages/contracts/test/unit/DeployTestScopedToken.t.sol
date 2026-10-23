// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeployTestScopedToken } from "../../script/test/DeployTestScopedToken.s.sol";
import { CanonicalDependencies } from "../utils/CanonicalDependencies.sol";
import { TestScopedToken } from "../utils/TestScopedToken.sol";

contract DeployTestScopedTokenUnitTest is CanonicalDependencies {
    function test_deployTestScopedToken_deploysTestScopedToken() public {
        DeployTestScopedToken deployTestScopedTokenScript = new DeployTestScopedToken();

        TestScopedToken testScopedToken = deployTestScopedTokenScript.deployTestScopedToken();

        assertEq(
            address(testScopedToken),
            vm.computeCreate2Address(deployTestScopedTokenScript.SALT(), keccak256(type(TestScopedToken).creationCode))
        );
    }
}
