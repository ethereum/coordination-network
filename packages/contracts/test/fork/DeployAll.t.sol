// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ISemaphoreGroups } from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

import { Test } from "forge-std/Test.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";

abstract contract DeployAllForkTest is Test {
    string internal constant FORK_DEPLOYMENTS_DIRECTORY = "deployments/fork/deploy-all";

    uint256 internal constant MAX_COST_PER_OP = 0.05 ether;

    DeployAll internal deployAllScript;

    address internal owner;

    function forkName() internal pure virtual returns (string memory);

    function setUp() public {
        vm.createSelectFork(forkName());

        deployAllScript = new DeployAll();
        deployAllScript.setDeploymentsDirectory(FORK_DEPLOYMENTS_DIRECTORY);
        owner = makeAddr("owner");
    }

    function _deployAll() internal returns (DeployAll.Deployment memory) {
        return deployAllScript.deployAll(DEFAULT_SENDER, owner, MAX_COST_PER_OP);
    }

    function test_deployAll_findsEveryDependencyItLinksAgainst() public view {
        assertGt(DeployedThirdPartyContracts.SEMAPHORE.code.length, 0);
        assertGt(DeployedThirdPartyContracts.SEMAPHORE_VERIFIER.code.length, 0);
        assertGt(DeployedThirdPartyContracts.ENTRY_POINT.code.length, 0);
        assertGt(DeployedThirdPartyContracts.POSEIDON_T3.code.length, 0);
        assertGt(DeployedThirdPartyContracts.POSEIDON_T4.code.length, 0);
        assertGt(DeployedThirdPartyContracts.SAFE_SINGLETON.code.length, 0);
        assertGt(DeployedThirdPartyContracts.SAFE_PROXY_FACTORY.code.length, 0);
        assertGt(DeployedThirdPartyContracts.SAFE_COMPATIBILITY_FALLBACK_HANDLER.code.length, 0);
    }

    function test_deployAll_deploysCodeAtEveryAddressItReturns() public {
        DeployAll.Deployment memory deployment = _deployAll();

        assertGt(address(deployment.governanceSafe).code.length, 0);
        assertGt(address(deployment.networkMemberRegistry).code.length, 0);
        assertGt(address(deployment.networkMemberGroup).code.length, 0);
        assertGt(address(deployment.networkMemberGovernance).code.length, 0);
        assertGt(address(deployment.approvedIssuerSet).code.length, 0);
        assertGt(address(deployment.identityRegistry).code.length, 0);
        assertGt(address(deployment.semaphorePaymaster).code.length, 0);
        assertGt(address(deployment.revocation).code.length, 0);
        assertGt(address(deployment.credentialRevocationRegistry).code.length, 0);
    }

    function test_deployAll_createsTheMemberGroupInSemaphoresDeployment() public {
        DeployAll.Deployment memory deployment = _deployAll();

        ISemaphoreGroups semaphoreGroups = ISemaphoreGroups(DeployedThirdPartyContracts.SEMAPHORE);
        uint256 networkMemberGroupId = deployment.networkMemberGroup.GROUP_ID();

        assertEq(semaphoreGroups.getGroupAdmin(networkMemberGroupId), address(deployment.networkMemberGroup));
        assertEq(semaphoreGroups.getMerkleTreeSize(networkMemberGroupId), 0);
    }
}

contract DeployAllSepoliaForkTest is DeployAllForkTest {
    function forkName() internal pure override returns (string memory) {
        return "sepolia";
    }
}

contract DeployAllMainnetForkTest is DeployAllForkTest {
    function forkName() internal pure override returns (string memory) {
        return "mainnet";
    }
}
