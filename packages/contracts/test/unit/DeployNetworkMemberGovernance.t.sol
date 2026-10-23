// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeployNetworkMemberGovernance } from "../../script/DeployNetworkMemberGovernance.s.sol";
import { NetworkMemberGovernance } from "../../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { ISafeGovernance } from "../../src/interfaces/ISafeGovernance.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract DeployNetworkMemberGovernanceUnitTest is NetworkMemberRegistryTestBase {
    function test_deployNetworkMemberGovernance_deploysNetworkMemberGovernance() public {
        DeployNetworkMemberGovernance deployNetworkMemberGovernanceScript = new DeployNetworkMemberGovernance();
        _deployGovernanceSafe(5);
        NetworkMemberRegistry networkMemberRegistry = new NetworkMemberRegistry(address(safe));
        NetworkMemberGroup networkMemberGroup = _deployNetworkMemberGroup(address(safe));
        bytes memory initCode = abi.encodePacked(
            type(NetworkMemberGovernance).creationCode,
            abi.encode(ISafeGovernance(address(safe)), networkMemberRegistry, networkMemberGroup)
        );

        NetworkMemberGovernance networkMemberGovernance =
            deployNetworkMemberGovernanceScript.deployNetworkMemberGovernance(
                address(safe), networkMemberRegistry, networkMemberGroup
            );

        assertEq(
            address(networkMemberGovernance),
            vm.computeCreate2Address(deployNetworkMemberGovernanceScript.SALT(), keccak256(initCode))
        );
    }
}
