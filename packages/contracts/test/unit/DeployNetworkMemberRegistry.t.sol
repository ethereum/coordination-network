// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeployNetworkMemberRegistry, ISafe } from "../../script/DeployNetworkMemberRegistry.s.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract DeployNetworkMemberRegistryUnitTest is NetworkMemberRegistryTestBase {
    DeployNetworkMemberRegistry internal deployNetworkMemberRegistryScript;

    function _setUpScript() internal {
        deployNetworkMemberRegistryScript = new DeployNetworkMemberRegistry();
    }

    function test_deployNetworkMemberRegistry_deploysNetworkMemberRegistry() public {
        _setUpScript();
        _deployGovernanceSafe(5);
        bytes memory initCode = abi.encodePacked(type(NetworkMemberRegistry).creationCode, abi.encode(address(safe)));

        NetworkMemberRegistry networkMemberRegistry =
            deployNetworkMemberRegistryScript.deployNetworkMemberRegistry(address(safe));

        assertEq(
            address(networkMemberRegistry),
            vm.computeCreate2Address(deployNetworkMemberRegistryScript.SALT(), keccak256(initCode))
        );
    }

    function test_governanceThreshold_isAMajorityOfTheMembers() public {
        _setUpScript();

        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(1), 1);
        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(2), 2);
        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(3), 2);
        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(4), 3);
        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(5), 3);
        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(8), 5);
        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(9), 5);
        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(9), 5);
        assertEq(deployNetworkMemberRegistryScript.governanceThreshold(10), 6);
    }

    function test_deployNetworkMemberRegistry_revertsWhenGovernanceIsAnEoa() public {
        _setUpScript();
        address singleOperator = makeAddr("singleOperator");

        vm.expectRevert(
            abi.encodeWithSelector(DeployNetworkMemberRegistry.GovernanceIsNotAContract.selector, singleOperator)
        );
        deployNetworkMemberRegistryScript.deployNetworkMemberRegistry(singleOperator);
    }

    function test_deployNetworkMemberRegistry_revertsWhenThresholdIsBelowTheMajority() public {
        _setUpScript();
        address governance = address(_deployGovernanceSafe(5, 2));

        vm.expectRevert(
            abi.encodeWithSelector(DeployNetworkMemberRegistry.GovernanceThresholdIsNotMajority.selector, 2, 3)
        );
        deployNetworkMemberRegistryScript.deployNetworkMemberRegistry(governance);
    }

    function test_deployNetworkMemberRegistry_revertsWhenThresholdIsAboveTheMajority() public {
        _setUpScript();
        address governance = address(_deployGovernanceSafe(5, 5));

        vm.expectRevert(
            abi.encodeWithSelector(DeployNetworkMemberRegistry.GovernanceThresholdIsNotMajority.selector, 5, 3)
        );
        deployNetworkMemberRegistryScript.deployNetworkMemberRegistry(governance);
    }

    function test_deployNetworkMemberRegistry_acceptsASingleFoundingMember() public {
        _setUpScript();
        _deployGovernanceSafe(1);

        assertEq(deployNetworkMemberRegistryScript.deployNetworkMemberRegistry(address(safe)).owner(), address(safe));
    }

    function test_deployNetworkMemberRegistry_revertsWhenTheOwnerSetIsEmpty() public {
        _setUpScript();
        _deployGovernanceSafe(5);
        vm.mockCall(address(safe), abi.encodeWithSelector(ISafe.getOwners.selector), abi.encode(new address[](0)));

        vm.expectRevert(abi.encodeWithSelector(DeployNetworkMemberRegistry.GovernanceOwnerSetTooSmall.selector, 0));
        deployNetworkMemberRegistryScript.deployNetworkMemberRegistry(address(safe));
    }
}
