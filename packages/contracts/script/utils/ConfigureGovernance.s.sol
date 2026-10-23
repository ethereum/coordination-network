// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { ModuleManager } from "@safe-global/safe-smart-account/contracts/base/ModuleManager.sol";
import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";

import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { SafeTransaction } from "../base/SafeTransaction.sol";

/// @notice The governance transactions a fresh deployment needs before it is usable.
contract ConfigureGovernance is SafeTransaction {
    function run() external {
        Safe governanceSafe = Safe(payable(vm.envAddress("GOVERNANCE_SAFE")));
        address owner = vm.envAddress("OWNER");
        NetworkMemberRegistry networkMemberRegistry = NetworkMemberRegistry(vm.envAddress("NETWORK_MEMBER_REGISTRY"));
        address approvedIssuerSet = vm.envAddress("APPROVED_ISSUER_SET");
        address networkMemberGovernance = vm.envAddress("NETWORK_MEMBER_GOVERNANCE");

        configureGovernance(governanceSafe, owner, networkMemberRegistry, approvedIssuerSet, networkMemberGovernance);
    }

    function configureGovernance(
        Safe governanceSafe,
        address owner,
        NetworkMemberRegistry networkMemberRegistry,
        address approvedIssuerSet,
        address networkMemberGovernance
    ) public {
        if (address(networkMemberRegistry.approvedIssuerSet()) == address(0)) {
            execFromSafe(
                governanceSafe,
                owner,
                address(networkMemberRegistry),
                abi.encodeCall(NetworkMemberRegistry.setApprovedIssuerSet, (approvedIssuerSet))
            );
            console.log("wired approved issuer set", approvedIssuerSet);
        }

        if (!governanceSafe.isModuleEnabled(networkMemberGovernance)) {
            execFromSafe(
                governanceSafe,
                owner,
                address(governanceSafe),
                abi.encodeCall(ModuleManager.enableModule, (networkMemberGovernance))
            );
            console.log("enabled governance module", networkMemberGovernance);
        }
    }
}
