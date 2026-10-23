// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { DeployAll } from "../../script/DeployAll.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract DeployAllUnitTest is NetworkMemberRegistryTestBase {
    DeployAll internal deployAllScript;

    uint256 internal constant MAX_COST_PER_OP = 0.05 ether;

    function _setUpScript(string memory deploymentsDirectory) internal {
        deployAllScript = new DeployAll();
        deployAllScript.setDeploymentsDirectory(deploymentsDirectory);
    }

    function _deployAll() internal returns (DeployAll.Deployment memory) {
        return deployAllScript.deployAll(DEFAULT_SENDER, owner, MAX_COST_PER_OP);
    }

    function test_deployAll_revertsWhen_DeployerIsOwner() public {
        _setUpScript("deployments/test/deployer-is-owner");

        vm.expectRevert(abi.encodeWithSelector(DeployAll.DeployerIsOwner.selector, DEFAULT_SENDER));
        deployAllScript.deployAll(DEFAULT_SENDER, DEFAULT_SENDER, MAX_COST_PER_OP);
    }

    function test_deployAll_revertsWhen_SenderIsNotTheDeployer() public {
        _setUpScript("deployments/test/sender-is-not-deployer");

        vm.expectRevert(abi.encodeWithSelector(DeployAll.SenderIsNotTheDeployer.selector, DEFAULT_SENDER));
        deployAllScript.deployAll(makeAddr("deployer"), owner, MAX_COST_PER_OP);
    }

    function test_deployAll_pointsEveryContractAtTheOnesItDependsOn() public {
        _setUpScript("deployments/test/wiring");

        DeployAll.Deployment memory deployment = _deployAll();
        address governanceSafe = address(deployment.governanceSafe);

        assertEq(deployment.governanceSafe.getOwners().length, 1);
        assertTrue(deployment.governanceSafe.isOwner(owner));
        assertEq(deployment.networkMemberRegistry.owner(), governanceSafe);
        assertEq(deployment.networkMemberGroup.owner(), governanceSafe);
        assertEq(address(deployment.networkMemberGroup.SEMAPHORE()), DeployedThirdPartyContracts.SEMAPHORE);
        assertEq(address(deployment.networkMemberGovernance.SAFE()), governanceSafe);
        assertEq(address(deployment.networkMemberGovernance.REGISTRY()), address(deployment.networkMemberRegistry));
        assertEq(address(deployment.networkMemberGovernance.GROUP()), address(deployment.networkMemberGroup));
        assertEq(deployment.approvedIssuerSet.memberRegistry(), address(deployment.networkMemberRegistry));
        assertEq(deployment.identityRegistry.NETWORK_MEMBER_GROUP_ID(), deployment.networkMemberGroup.GROUP_ID());
        assertEq(deployment.semaphorePaymaster.owner(), owner);
        assertEq(address(deployment.credentialRevocationRegistry.REVOCATION()), address(deployment.revocation));
        assertEq(
            deployment.revocation.getRegistryAdmin(deployment.credentialRevocationRegistry.REGISTRY_ID()),
            address(deployment.credentialRevocationRegistry)
        );
    }

    function test_deployAll_writesEveryAddressToTheChainsDeploymentFile() public {
        _setUpScript("deployments/test/manifest");

        DeployAll.Deployment memory deployment = _deployAll();

        string memory deploymentJson =
            vm.readFile(string.concat("deployments/test/manifest/", vm.toString(block.chainid), ".json"));
        assertEq(vm.parseJsonUint(deploymentJson, ".chainId"), block.chainid);
        assertEq(
            vm.parseJsonAddress(deploymentJson, ".networkMemberRegistry"), address(deployment.networkMemberRegistry)
        );
        assertEq(vm.parseJsonAddress(deploymentJson, ".networkMemberGroup"), address(deployment.networkMemberGroup));
        assertEq(vm.parseJsonUint(deploymentJson, ".networkMemberGroupId"), deployment.networkMemberGroup.GROUP_ID());
        assertEq(
            vm.parseJsonAddress(deploymentJson, ".networkMemberGovernance"), address(deployment.networkMemberGovernance)
        );
        assertEq(vm.parseJsonAddress(deploymentJson, ".approvedIssuerSet"), address(deployment.approvedIssuerSet));
        assertEq(vm.parseJsonAddress(deploymentJson, ".identityRegistry"), address(deployment.identityRegistry));
        assertEq(vm.parseJsonAddress(deploymentJson, ".semaphorePaymaster"), address(deployment.semaphorePaymaster));
        assertEq(vm.parseJsonAddress(deploymentJson, ".revocation"), address(deployment.revocation));
        assertEq(vm.parseJsonAddress(deploymentJson, ".governanceSafe"), address(deployment.governanceSafe));
        assertEq(
            vm.parseJsonAddress(deploymentJson, ".credentialRevocationRegistry"),
            address(deployment.credentialRevocationRegistry)
        );
    }

    function test_deployAll_writesTheThirdPartyAddressesToTheChainsDeploymentFile() public {
        _setUpScript("deployments/test/third-party");

        _deployAll();

        string memory deploymentJson =
            vm.readFile(string.concat("deployments/test/third-party/", vm.toString(block.chainid), ".json"));
        assertEq(vm.parseJsonAddress(deploymentJson, ".thirdParty.entryPoint"), DeployedThirdPartyContracts.ENTRY_POINT);
        assertEq(
            vm.parseJsonAddress(deploymentJson, ".thirdParty.simple7702Account"),
            DeployedThirdPartyContracts.SIMPLE_7702_ACCOUNT
        );
        assertEq(vm.parseJsonAddress(deploymentJson, ".thirdParty.semaphore"), DeployedThirdPartyContracts.SEMAPHORE);
        assertEq(
            vm.parseJsonAddress(deploymentJson, ".thirdParty.erc5564Announcer"),
            DeployedThirdPartyContracts.ERC5564_ANNOUNCER
        );
        assertEq(
            vm.parseJsonAddress(deploymentJson, ".thirdParty.safeMultiSendCallOnly"),
            DeployedThirdPartyContracts.SAFE_MULTI_SEND_CALL_ONLY
        );
    }

    function test_deployAll_recordsWhatEachContractCostToDeploy() public {
        _setUpScript("deployments/test/gas");

        _deployAll();

        string memory deploymentJson =
            vm.readFile(string.concat("deployments/test/gas/", vm.toString(block.chainid), ".json"));
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.governanceSafe"), 0);
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.networkMemberRegistry"), 0);
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.networkMemberGroup"), 0);
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.networkMemberGovernance"), 0);
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.approvedIssuerSet"), 0);
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.identityRegistry"), 0);
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.semaphorePaymaster"), 0);
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.revocation"), 0);
        assertGt(vm.parseJsonUint(deploymentJson, ".gas.credentialRevocationRegistry"), 0);
    }

    function test_deployAll_aSecondRunRedeploysNothing() public {
        _setUpScript("deployments/test/second-run");

        DeployAll.Deployment memory first = _deployAll();
        DeployAll.Deployment memory second = _deployAll();

        assertEq(address(first.governanceSafe), address(second.governanceSafe));
        assertEq(address(first.networkMemberRegistry), address(second.networkMemberRegistry));
        assertEq(address(first.networkMemberGroup), address(second.networkMemberGroup));
        assertEq(address(first.networkMemberGovernance), address(second.networkMemberGovernance));
        assertEq(address(first.approvedIssuerSet), address(second.approvedIssuerSet));
        assertEq(address(first.identityRegistry), address(second.identityRegistry));
        assertEq(address(first.semaphorePaymaster), address(second.semaphorePaymaster));
        assertEq(address(first.revocation), address(second.revocation));
    }
}
