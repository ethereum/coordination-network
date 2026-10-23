// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Test } from "forge-std/Test.sol";

import { DeployBaseHarness } from "../utils/DeployBaseHarness.sol";
import { TestScopedToken } from "../utils/TestScopedToken.sol";

contract DeployBaseUnitTest is Test {
    DeployBaseHarness internal deployBaseHarness;

    bytes32 internal constant SALT = keccak256("DeployBaseUnitTest");

    function setUp() public {
        deployBaseHarness = new DeployBaseHarness();
    }

    function test_alreadyDeployedAt_isZeroWhenTheSaltedAddressIsEmpty() public view {
        assertEq(deployBaseHarness.deployedAt(SALT, type(TestScopedToken).creationCode), address(0));
    }

    function test_alreadyDeployedAt_isTheSaltedAddressOnceSomethingIsThere() public {
        TestScopedToken testScopedToken = deployBaseHarness.deploy(SALT);

        assertEq(deployBaseHarness.deployedAt(SALT, type(TestScopedToken).creationCode), address(testScopedToken));
    }

    function test_alreadyDeployedAt_isZeroForADifferentSalt() public {
        deployBaseHarness.deploy(SALT);

        assertEq(deployBaseHarness.deployedAt(keccak256("another"), type(TestScopedToken).creationCode), address(0));
    }
}
