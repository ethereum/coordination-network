// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";
import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { IStakeManager } from "@account-abstraction/contracts/interfaces/IStakeManager.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { DeployAndConfigureAll } from "../../script/DeployAndConfigureAll.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { FundPaymaster } from "../../script/utils/FundPaymaster.s.sol";
import { CanonicalDependencies } from "../utils/CanonicalDependencies.sol";

contract DeployAndConfigureAllUnitTest is CanonicalDependencies {
    uint256 internal constant MAX_COST_PER_OP = 0.05 ether;
    uint256 internal constant PAYMASTER_DEPOSIT = 0.1 ether;
    uint256 internal constant PAYMASTER_STAKE = 1 ether;
    uint32 internal constant PAYMASTER_UNSTAKE_DELAY = 1 days;
    uint256 internal constant NETWORK_MEMBER_COMMITMENT = 12_345;

    DeployAndConfigureAll internal deployAndConfigureAllScript;
    DeployAndConfigureAll.Configuration internal configuration;

    address internal owner;
    Vm.Wallet internal memberWallet;

    function setUp() public {
        owner = makeAddr("owner");
        memberWallet = vm.createWallet("memberAccountKey");
        deployAndConfigureAllScript = new DeployAndConfigureAll();
        deployAndConfigureAllScript.setDeploymentsDirectory("deployments/test/deploy-and-configure");
        vm.deal(owner, 10 ether);

        configuration = DeployAndConfigureAll.Configuration({
            deployer: DEFAULT_SENDER,
            owner: owner,
            maxCostPerOp: MAX_COST_PER_OP,
            paymasterDeposit: PAYMASTER_DEPOSIT,
            paymasterStake: PAYMASTER_STAKE,
            paymasterUnstakeDelay: PAYMASTER_UNSTAKE_DELAY,
            memberAccountKey: abi.encode(memberWallet.publicKeyX, memberWallet.publicKeyY),
            networkMemberCommitment: NETWORK_MEMBER_COMMITMENT
        });
    }

    function test_deployAndConfigureAll_deploysAndConfiguresEverything() public {
        DeployAll.Deployment memory deployment = deployAndConfigureAllScript.deployAndConfigureAll(configuration);

        IStakeManager.DepositInfo memory funded =
            IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT).getDepositInfo(address(deployment.semaphorePaymaster));
        assertTrue(deployment.governanceSafe.isModuleEnabled(address(deployment.networkMemberGovernance)));
        assertEq(funded.deposit, PAYMASTER_DEPOSIT);
        assertEq(funded.stake, PAYMASTER_STAKE);
        assertEq(funded.unstakeDelaySec, PAYMASTER_UNSTAKE_DELAY);
        assertEq(
            deployment.networkMemberRegistry
                .governanceSignerOf(keccak256(abi.encodePacked(memberWallet.publicKeyX, memberWallet.publicKeyY))),
            owner
        );
        assertTrue(deployment.networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));
        assertTrue(
            deployment.semaphorePaymaster.hasMember(deployment.semaphorePaymaster.GROUP_ID(), NETWORK_MEMBER_COMMITMENT)
        );
    }

    function test_deployAndConfigureAll_aSecondRunWithTheSameFoundingMemberChangesNothing() public {
        deployAndConfigureAllScript.deployAndConfigureAll(configuration);

        DeployAll.Deployment memory deployment = deployAndConfigureAllScript.deployAndConfigureAll(configuration);

        bytes32 memberNetworkId = keccak256(abi.encodePacked(memberWallet.publicKeyX, memberWallet.publicKeyY));
        assertTrue(deployment.networkMemberRegistry.isApproved(memberNetworkId));
        assertTrue(deployment.networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));
        assertEq(deployment.semaphorePaymaster.getMerkleTreeSize(deployment.semaphorePaymaster.GROUP_ID()), 1);
    }

    function test_deployAndConfigureAll_revertsWhen_DifferentFoundingMemberAdmitted() public {
        deployAndConfigureAllScript.deployAndConfigureAll(configuration);
        Vm.Wallet memory differentMemberWallet = vm.createWallet("differentMemberAccountKey");
        configuration.memberAccountKey = abi.encode(differentMemberWallet.publicKeyX, differentMemberWallet.publicKeyY);
        configuration.networkMemberCommitment = NETWORK_MEMBER_COMMITMENT + 1;

        vm.expectRevert(DeployAndConfigureAll.DifferentFoundingMemberAdmitted.selector);
        deployAndConfigureAllScript.deployAndConfigureAll(configuration);
    }

    function test_deployAndConfigureAll_skipsFundingWhenThePaymasterIsAlreadyStaked() public {
        DeployAll deployAllScript = new DeployAll();
        deployAllScript.setDeploymentsDirectory("deployments/test/deploy-and-configure");
        DeployAll.Deployment memory deployment = deployAllScript.deployAll(DEFAULT_SENDER, owner, MAX_COST_PER_OP);
        new FundPaymaster()
            .fundPaymaster(deployment.semaphorePaymaster, PAYMASTER_DEPOSIT, PAYMASTER_STAKE, PAYMASTER_UNSTAKE_DELAY);
        IEntryPoint entryPoint = IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT);
        address semaphorePaymaster = address(deployment.semaphorePaymaster);

        assertEq(entryPoint.getDepositInfo(semaphorePaymaster).stake, PAYMASTER_STAKE);

        deployAndConfigureAllScript.deployAndConfigureAll(configuration);

        IStakeManager.DepositInfo memory funded = entryPoint.getDepositInfo(semaphorePaymaster);
        assertEq(funded.deposit, PAYMASTER_DEPOSIT);
        assertEq(funded.stake, PAYMASTER_STAKE);
    }
}
