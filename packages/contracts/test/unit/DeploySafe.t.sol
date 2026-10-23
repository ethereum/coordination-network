// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";
import { SafeProxyFactory } from "@safe-global/safe-smart-account/contracts/proxies/SafeProxyFactory.sol";

import { DeploySafe } from "../../script/DeploySafe.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { ISafeGovernance } from "../../src/interfaces/ISafeGovernance.sol";
import { NetworkMemberGovernance } from "../../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { CanonicalDependencies } from "../utils/CanonicalDependencies.sol";

contract DeploySafeUnitTest is CanonicalDependencies {
    DeploySafe internal deploySafeScript;

    address[] internal owners;

    function setUp() public {
        deploySafeScript = new DeploySafe();
        owners = [makeAddr("firstOwner"), makeAddr("secondOwner"), makeAddr("thirdOwner")];
    }

    function _expectedSafeAddress(address[] memory safeOwners, uint256 threshold) internal view returns (address) {
        bytes memory initializer = abi.encodeCall(
            Safe.setup,
            (
                safeOwners,
                threshold,
                address(0),
                "",
                DeployedThirdPartyContracts.SAFE_COMPATIBILITY_FALLBACK_HANDLER,
                address(0),
                0,
                payable(address(0))
            )
        );
        bytes memory proxyInitCode = abi.encodePacked(
            SafeProxyFactory(DeployedThirdPartyContracts.SAFE_PROXY_FACTORY).proxyCreationCode(),
            uint256(uint160(DeployedThirdPartyContracts.SAFE_SINGLETON))
        );

        return vm.computeCreate2Address(
            keccak256(abi.encodePacked(keccak256(initializer), deploySafeScript.SALT_NONCE())),
            keccak256(proxyInitCode),
            DeployedThirdPartyContracts.SAFE_PROXY_FACTORY
        );
    }

    function test_deploySafe_deploysTheSafeThroughSafesOwnFactory() public {
        Safe governanceSafe = deploySafeScript.deploySafe(owners);

        assertEq(address(governanceSafe), _expectedSafeAddress(owners, 2));
    }

    function test_deploySafe_returnsTheExistingSafeWhenRunAgain() public {
        Safe governanceSafe = deploySafeScript.deploySafe(owners);

        assertEq(address(deploySafeScript.deploySafe(owners)), address(governanceSafe));
    }

    function test_deploySafe_revertsWhenThereAreNoOwners() public {
        address[] memory noOwners = new address[](0);

        vm.expectRevert(DeploySafe.NoOwners.selector);
        deploySafeScript.deploySafe(noOwners);
    }

    function testFuzz_deploySafe_requiresTheThresholdGovernanceComputes(uint256 ownerCount) public {
        ownerCount = bound(ownerCount, 1, 10);
        address[] memory safeOwners = new address[](ownerCount);
        for (uint256 ownerIndex = 0; ownerIndex < ownerCount; ownerIndex++) {
            safeOwners[ownerIndex] = makeAddr(string.concat("owner", vm.toString(ownerIndex)));
        }
        NetworkMemberGovernance networkMemberGovernance = new NetworkMemberGovernance(
            ISafeGovernance(makeAddr("safe")),
            NetworkMemberRegistry(makeAddr("registry")),
            NetworkMemberGroup(makeAddr("group"))
        );

        Safe governanceSafe = deploySafeScript.deploySafe(safeOwners);

        assertEq(governanceSafe.getThreshold(), networkMemberGovernance.governanceThreshold(ownerCount));
    }
}
