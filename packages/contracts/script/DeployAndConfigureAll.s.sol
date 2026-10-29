// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script } from "forge-std/Script.sol";

import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { ISemaphoreGroups } from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";

import { NetworkMemberGroup } from "../src/NetworkMemberGroup.sol";

import { DeployedThirdPartyContracts } from "./libraries/DeployedThirdPartyContracts.sol";
import { DeployAll } from "./DeployAll.s.sol";
import { AddPaymasterMember } from "./utils/AddPaymasterMember.s.sol";
import { AdmitNetworkMember } from "./utils/AdmitNetworkMember.s.sol";
import { ConfigureGovernance } from "./utils/ConfigureGovernance.s.sol";
import { FundPaymaster } from "./utils/FundPaymaster.s.sol";

/// @notice Deploys everything, then configures it: wires the issuer set, enables the governance
/// module, funds the paymaster, admits the founding network member and adds it to the paymaster group.
/// @dev Needs two keys in one run: the deployer sends the deployments, and the owner sends the Safe
/// transactions and the stake.
contract DeployAndConfigureAll is Script {
    struct Configuration {
        address deployer;
        address owner;
        uint256 maxCostPerOp;
        uint256 paymasterDeposit;
        uint256 paymasterStake;
        uint32 paymasterUnstakeDelay;
        bytes memberAccountKey;
        uint256 networkMemberCommitment;
    }

    error DifferentFoundingMemberAdmitted();

    DeployAll internal deployAllScript = new DeployAll();
    ConfigureGovernance internal configureGovernanceScript = new ConfigureGovernance();
    FundPaymaster internal fundPaymasterScript = new FundPaymaster();
    AdmitNetworkMember internal admitNetworkMemberScript = new AdmitNetworkMember();
    AddPaymasterMember internal addPaymasterMemberScript = new AddPaymasterMember();

    function setDeploymentsDirectory(string memory directory) external {
        deployAllScript.setDeploymentsDirectory(directory);
    }

    function run() external returns (DeployAll.Deployment memory deployment) {
        Configuration memory configuration = Configuration({
            deployer: vm.envAddress("DEPLOYER"),
            owner: vm.envAddress("OWNER"),
            maxCostPerOp: vm.envUint("MAX_COST_PER_OP"),
            paymasterDeposit: vm.envUint("PAYMASTER_DEPOSIT"),
            paymasterStake: vm.envUint("PAYMASTER_STAKE"),
            paymasterUnstakeDelay: uint32(vm.envUint("PAYMASTER_UNSTAKE_DELAY")),
            memberAccountKey: vm.envBytes("MEMBER_ACCOUNT_PUBLIC_KEY"),
            networkMemberCommitment: vm.envUint("NETWORK_MEMBER_COMMITMENT")
        });

        return deployAndConfigureAll(configuration);
    }

    function deployAndConfigureAll(Configuration memory configuration)
        public
        returns (DeployAll.Deployment memory deployment)
    {
        deployment = deployAllScript.deployAll(configuration.deployer, configuration.owner, configuration.maxCostPerOp);

        configureGovernanceScript.configureGovernance(
            deployment.governanceSafe,
            configuration.owner,
            deployment.networkMemberRegistry,
            address(deployment.approvedIssuerSet),
            address(deployment.networkMemberGovernance)
        );

        uint256 paymasterStake =
            IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT)
        .getDepositInfo(address(deployment.semaphorePaymaster))
        .stake;
        if (paymasterStake == 0) {
            fundPaymasterScript.fundPaymaster(
                deployment.semaphorePaymaster,
                configuration.paymasterDeposit,
                configuration.paymasterStake,
                configuration.paymasterUnstakeDelay
            );
        }

        NetworkMemberGroup networkMemberGroup = deployment.networkMemberGroup;
        ISemaphoreGroups semaphoreGroups = ISemaphoreGroups(address(networkMemberGroup.SEMAPHORE()));
        bool isFoundingMemberAdmitted = networkMemberGroup.hasNetworkMember(configuration.networkMemberCommitment);
        bool isAnyMemberAdmitted = semaphoreGroups.getMerkleTreeSize(networkMemberGroup.GROUP_ID()) > 0;
        bool isDifferentFoundingMemberAdmitted = isAnyMemberAdmitted && !isFoundingMemberAdmitted;
        if (isDifferentFoundingMemberAdmitted) revert DifferentFoundingMemberAdmitted();

        admitNetworkMemberScript.admitNetworkMember(
            deployment.governanceSafe,
            configuration.owner,
            deployment.networkMemberGovernance,
            configuration.memberAccountKey,
            configuration.networkMemberCommitment,
            configuration.owner
        );

        addPaymasterMemberScript.addPaymasterMember(
            deployment.semaphorePaymaster, configuration.networkMemberCommitment
        );
    }
}
