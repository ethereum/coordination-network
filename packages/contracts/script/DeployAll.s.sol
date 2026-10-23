// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script, console } from "forge-std/Script.sol";

import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";
import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { ApprovedIssuerSet } from "../src/ApprovedIssuerSet.sol";
import { CredentialRevocationRegistry } from "../src/CredentialRevocationRegistry.sol";
import { IdentityRegistry } from "../src/IdentityRegistry.sol";
import { NetworkMemberGovernance } from "../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../src/NetworkMemberRegistry.sol";
import { IRevocation } from "../src/revocation/interfaces/IRevocation.sol";
import { Revocation } from "../src/revocation/Revocation.sol";
import { SemaphorePaymaster } from "../src/SemaphorePaymaster.sol";

import { DeployedThirdPartyContracts } from "./libraries/DeployedThirdPartyContracts.sol";
import { DeployApprovedIssuerSet } from "./DeployApprovedIssuerSet.s.sol";
import { DeployCredentialRevocationRegistry } from "./DeployCredentialRevocationRegistry.s.sol";
import { DeployIdentityRegistry } from "./DeployIdentityRegistry.s.sol";
import { DeployNetworkMemberGovernance } from "./DeployNetworkMemberGovernance.s.sol";
import { DeployNetworkMemberGroup } from "./DeployNetworkMemberGroup.s.sol";
import { DeployNetworkMemberRegistry } from "./DeployNetworkMemberRegistry.s.sol";
import { DeployRevocation } from "./DeployRevocation.s.sol";
import { DeploySafe } from "./DeploySafe.s.sol";
import { DeploySemaphorePaymaster } from "./DeploySemaphorePaymaster.s.sol";

contract DeployAll is Script {
    error DeployerIsOwner(address deployer);
    error SenderIsNotTheDeployer(address sender);

    struct Deployment {
        Safe governanceSafe;
        NetworkMemberRegistry networkMemberRegistry;
        NetworkMemberGroup networkMemberGroup;
        NetworkMemberGovernance networkMemberGovernance;
        ApprovedIssuerSet approvedIssuerSet;
        IdentityRegistry identityRegistry;
        SemaphorePaymaster semaphorePaymaster;
        Revocation revocation;
        CredentialRevocationRegistry credentialRevocationRegistry;
    }

    ISemaphore internal semaphore = ISemaphore(DeployedThirdPartyContracts.SEMAPHORE);

    string public deploymentsDirectory = "deployments";

    DeploySafe internal governanceSafeScript = new DeploySafe();
    DeployNetworkMemberRegistry internal networkMemberRegistryScript = new DeployNetworkMemberRegistry();
    DeployNetworkMemberGroup internal networkMemberGroupScript = new DeployNetworkMemberGroup();
    DeployNetworkMemberGovernance internal networkMemberGovernanceScript = new DeployNetworkMemberGovernance();
    DeployApprovedIssuerSet internal approvedIssuerSetScript = new DeployApprovedIssuerSet();
    DeployIdentityRegistry internal identityRegistryScript = new DeployIdentityRegistry();
    DeploySemaphorePaymaster internal semaphorePaymasterScript = new DeploySemaphorePaymaster();
    DeployRevocation internal revocationScript = new DeployRevocation();
    DeployCredentialRevocationRegistry internal credentialRevocationRegistryScript =
        new DeployCredentialRevocationRegistry();

    function setDeploymentsDirectory(string memory directory) external {
        deploymentsDirectory = directory;
    }

    function run() external returns (Deployment memory deployment) {
        address deployer = vm.envAddress("DEPLOYER");
        address owner = vm.envAddress("OWNER");
        uint256 maxCostPerOp = vm.envUint("MAX_COST_PER_OP");

        return deployAll(deployer, owner, maxCostPerOp);
    }

    /// @notice Deploys the Safe and every contract, sending each deployment from `deployer`.
    /// @param deployer The key that sends the deployments.
    /// @param owner The Safe's founding owner. Must differ from `deployer`.
    /// @param maxCostPerOp The most the paymaster pays for one operation, in wei.
    function deployAll(address deployer, address owner, uint256 maxCostPerOp)
        public
        returns (Deployment memory deployment)
    {
        if (owner == deployer) revert DeployerIsOwner(deployer);
        if (tx.origin != deployer) revert SenderIsNotTheDeployer(tx.origin);

        address[] memory governanceSafeOwners = new address[](1);
        governanceSafeOwners[0] = owner;

        deployment.governanceSafe = governanceSafeScript.deploySafe(governanceSafeOwners);
        address governanceSafe = address(deployment.governanceSafe);

        deployment.networkMemberRegistry = networkMemberRegistryScript.deployNetworkMemberRegistry(governanceSafe);
        deployment.networkMemberGroup = networkMemberGroupScript.deployNetworkMemberGroup(governanceSafe, semaphore);
        deployment.networkMemberGovernance = networkMemberGovernanceScript.deployNetworkMemberGovernance(
            governanceSafe, deployment.networkMemberRegistry, deployment.networkMemberGroup
        );
        deployment.approvedIssuerSet =
            approvedIssuerSetScript.deployApprovedIssuerSet(address(deployment.networkMemberRegistry));
        deployment.identityRegistry =
            identityRegistryScript.deployIdentityRegistry(semaphore, deployment.networkMemberGroup.GROUP_ID());
        deployment.semaphorePaymaster = semaphorePaymasterScript.deploySemaphorePaymaster(owner, maxCostPerOp);
        deployment.revocation = revocationScript.deployRevocation();
        deployment.credentialRevocationRegistry = credentialRevocationRegistryScript.deployCredentialRevocationRegistry(
            semaphore, deployment.networkMemberGroup.GROUP_ID(), IRevocation(address(deployment.revocation))
        );

        _writeDeploymentFile(deployment);
    }

    function _serializeDeploymentGas() internal returns (string memory) {
        string memory gasJson = "gas";
        vm.serializeUint(gasJson, "governanceSafe", governanceSafeScript.deploymentGas());
        vm.serializeUint(gasJson, "networkMemberRegistry", networkMemberRegistryScript.deploymentGas());
        vm.serializeUint(gasJson, "networkMemberGroup", networkMemberGroupScript.deploymentGas());
        vm.serializeUint(gasJson, "networkMemberGovernance", networkMemberGovernanceScript.deploymentGas());
        vm.serializeUint(gasJson, "approvedIssuerSet", approvedIssuerSetScript.deploymentGas());
        vm.serializeUint(gasJson, "identityRegistry", identityRegistryScript.deploymentGas());
        vm.serializeUint(gasJson, "semaphorePaymaster", semaphorePaymasterScript.deploymentGas());
        vm.serializeUint(gasJson, "revocation", revocationScript.deploymentGas());
        string memory serializedGas = vm.serializeUint(
            gasJson, "credentialRevocationRegistry", credentialRevocationRegistryScript.deploymentGas()
        );

        return serializedGas;
    }

    /// @dev The pre-deployed contracts the network uses, so consumers read them from the deployment file.
    function _serializeThirdPartyContracts() internal returns (string memory) {
        string memory thirdPartyJson = "thirdParty";
        vm.serializeAddress(thirdPartyJson, "entryPoint", DeployedThirdPartyContracts.ENTRY_POINT);
        vm.serializeAddress(thirdPartyJson, "simple7702Account", DeployedThirdPartyContracts.SIMPLE_7702_ACCOUNT);
        vm.serializeAddress(thirdPartyJson, "semaphore", DeployedThirdPartyContracts.SEMAPHORE);
        vm.serializeAddress(thirdPartyJson, "erc5564Announcer", DeployedThirdPartyContracts.ERC5564_ANNOUNCER);
        return vm.serializeAddress(
            thirdPartyJson, "safeMultiSendCallOnly", DeployedThirdPartyContracts.SAFE_MULTI_SEND_CALL_ONLY
        );
    }

    function _writeDeploymentFile(Deployment memory deployment) internal {
        string memory deploymentJson = "deployment";
        vm.serializeUint(deploymentJson, "chainId", block.chainid);
        vm.serializeUint(deploymentJson, "blockNumber", block.number);
        vm.serializeAddress(deploymentJson, "governanceSafe", address(deployment.governanceSafe));
        vm.serializeString(deploymentJson, "gas", _serializeDeploymentGas());
        vm.serializeAddress(deploymentJson, "networkMemberRegistry", address(deployment.networkMemberRegistry));
        vm.serializeAddress(deploymentJson, "networkMemberGroup", address(deployment.networkMemberGroup));
        vm.serializeUint(deploymentJson, "networkMemberGroupId", deployment.networkMemberGroup.GROUP_ID());
        vm.serializeAddress(deploymentJson, "networkMemberGovernance", address(deployment.networkMemberGovernance));
        vm.serializeAddress(deploymentJson, "approvedIssuerSet", address(deployment.approvedIssuerSet));
        vm.serializeAddress(deploymentJson, "identityRegistry", address(deployment.identityRegistry));
        vm.serializeAddress(deploymentJson, "semaphorePaymaster", address(deployment.semaphorePaymaster));
        vm.serializeAddress(deploymentJson, "revocation", address(deployment.revocation));
        vm.serializeUint(
            deploymentJson, "credentialRevocationRegistryId", deployment.credentialRevocationRegistry.REGISTRY_ID()
        );
        vm.serializeAddress(
            deploymentJson, "credentialRevocationRegistry", address(deployment.credentialRevocationRegistry)
        );
        string memory json = vm.serializeString(deploymentJson, "thirdParty", _serializeThirdPartyContracts());

        string memory path = string.concat(deploymentsDirectory, "/", vm.toString(block.chainid), ".json");
        vm.createDir(deploymentsDirectory, true);
        vm.writeJson(json, path);
        console.log("wrote", path);
    }
}
