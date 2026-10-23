// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { IStakeManager } from "@account-abstraction/contracts/interfaces/IStakeManager.sol";
import { SNARK_SCALAR_FIELD } from "@zk-kit/lean-imt.sol/Constants.sol";

import { Test, Vm } from "forge-std/Test.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { DeployAndConfigureAll } from "../../script/DeployAndConfigureAll.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";

abstract contract DeployAndConfigureAllForkTest is Test {
    string internal constant FORK_DEPLOYMENTS_DIRECTORY = "deployments/fork/deploy-and-configure-all";

    uint256 internal constant MAX_COST_PER_OP = 0.05 ether;
    uint256 internal constant PAYMASTER_DEPOSIT = 0.1 ether;
    uint256 internal constant PAYMASTER_STAKE = 1 ether;
    uint32 internal constant PAYMASTER_UNSTAKE_DELAY = 1 days;

    DeployAll.Deployment internal deployment;

    address internal owner;
    uint256 internal networkMemberCommitment;

    function forkName() internal pure virtual returns (string memory);

    function setUp() public {
        vm.createSelectFork(forkName());

        owner = makeAddr("owner");
        Vm.Wallet memory memberWallet = vm.createWallet("memberAccountKey");
        networkMemberCommitment = uint256(keccak256("networkMemberCommitment")) % SNARK_SCALAR_FIELD;
        vm.deal(owner, PAYMASTER_DEPOSIT + PAYMASTER_STAKE);

        DeployAndConfigureAll deployAndConfigureAllScript = new DeployAndConfigureAll();
        deployAndConfigureAllScript.setDeploymentsDirectory(FORK_DEPLOYMENTS_DIRECTORY);
        deployment = deployAndConfigureAllScript.deployAndConfigureAll(
            DeployAndConfigureAll.Configuration({
                deployer: DEFAULT_SENDER,
                owner: owner,
                maxCostPerOp: MAX_COST_PER_OP,
                paymasterDeposit: PAYMASTER_DEPOSIT,
                paymasterStake: PAYMASTER_STAKE,
                paymasterUnstakeDelay: PAYMASTER_UNSTAKE_DELAY,
                memberAccountKeyX: memberWallet.publicKeyX,
                memberAccountKeyY: memberWallet.publicKeyY,
                networkMemberCommitment: networkMemberCommitment
            })
        );
    }

    function test_deployAndConfigureAll_configuresFundsAndAdmitsAgainstTheRealDependencies() public view {
        assertTrue(deployment.governanceSafe.isModuleEnabled(address(deployment.networkMemberGovernance)));

        IStakeManager.DepositInfo memory funded =
            IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT).getDepositInfo(address(deployment.semaphorePaymaster));
        assertEq(funded.deposit, PAYMASTER_DEPOSIT);
        assertEq(funded.stake, PAYMASTER_STAKE);

        assertTrue(deployment.networkMemberGroup.hasNetworkMember(networkMemberCommitment));
        assertTrue(
            deployment.semaphorePaymaster.hasMember(deployment.semaphorePaymaster.GROUP_ID(), networkMemberCommitment)
        );
    }
}

contract DeployAndConfigureAllSepoliaForkTest is DeployAndConfigureAllForkTest {
    function forkName() internal pure override returns (string memory) {
        return "sepolia";
    }
}

contract DeployAndConfigureAllMainnetForkTest is DeployAndConfigureAllForkTest {
    function forkName() internal pure override returns (string memory) {
        return "mainnet";
    }
}
