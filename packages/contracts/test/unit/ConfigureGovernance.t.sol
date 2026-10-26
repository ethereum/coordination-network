// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ModuleManager } from "@safe-global/safe-smart-account/contracts/base/ModuleManager.sol";
import { Enum } from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";
import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";

import { DeploySafe } from "../../script/DeploySafe.s.sol";
import { SafeTransaction } from "../../script/base/SafeTransaction.sol";
import { ConfigureGovernance } from "../../script/utils/ConfigureGovernance.s.sol";
import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { CanonicalDependencies } from "../utils/CanonicalDependencies.sol";

contract ConfigureGovernanceUnitTest is CanonicalDependencies {
    ConfigureGovernance internal configureGovernanceScript;
    Safe internal governanceSafe;
    NetworkMemberRegistry internal networkMemberRegistry;
    ApprovedIssuerSet internal approvedIssuerSet;

    address internal owner;
    address internal networkMemberGovernance;

    function setUp() public {
        owner = makeAddr("owner");
        address[] memory owners = new address[](1);
        owners[0] = owner;
        governanceSafe = new DeploySafe().deploySafe(owners);

        configureGovernanceScript = new ConfigureGovernance();
        networkMemberRegistry = new NetworkMemberRegistry(address(governanceSafe));
        approvedIssuerSet = new ApprovedIssuerSet(address(networkMemberRegistry));
        networkMemberGovernance = makeAddr("networkMemberGovernance");
    }

    function _configureGovernance() internal {
        configureGovernanceScript.configureGovernance(
            governanceSafe, owner, networkMemberRegistry, address(approvedIssuerSet), networkMemberGovernance
        );
    }

    function test_configureGovernance_wiresTheIssuerSetAndEnablesTheGovernanceModule() public {
        _configureGovernance();

        assertEq(address(networkMemberRegistry.approvedIssuerSet()), address(approvedIssuerSet));
        assertTrue(governanceSafe.isModuleEnabled(networkMemberGovernance));
    }

    function test_configureGovernance_aSecondRunChangesNothing() public {
        _configureGovernance();

        _configureGovernance();

        assertEq(address(networkMemberRegistry.approvedIssuerSet()), address(approvedIssuerSet));
        assertTrue(governanceSafe.isModuleEnabled(networkMemberGovernance));
    }

    function test_configureGovernance_revertsWhenTheSafeOwnerDoesNotOwnTheSafe() public {
        address[] memory owners = new address[](1);
        owners[0] = makeAddr("someoneElse");
        Safe otherSafe = new DeploySafe().deploySafe(owners);

        vm.expectRevert(abi.encodeWithSelector(SafeTransaction.NotASafeOwner.selector, owner));
        configureGovernanceScript.configureGovernance(
            otherSafe, owner, networkMemberRegistry, address(approvedIssuerSet), networkMemberGovernance
        );
    }

    function test_configureGovernance_revertsWhenTheOtherOwnersHaveNotApproved() public {
        address[] memory owners = new address[](3);
        owners[0] = owner;
        owners[1] = makeAddr("secondOwner");
        owners[2] = makeAddr("thirdOwner");
        Safe sharedSafe = new DeploySafe().deploySafe(owners);

        vm.expectRevert(abi.encodeWithSelector(SafeTransaction.NotEnoughApprovals.selector, 1, 2));
        configureGovernanceScript.configureGovernance(
            sharedSafe, owner, networkMemberRegistry, address(approvedIssuerSet), networkMemberGovernance
        );
    }

    function test_configureGovernance_executesOnASafeWhoseOwnersAreStoredHighestFirst() public {
        address secondOwner = makeAddr("secondOwner");
        address[] memory ownersHighestFirst = new address[](2);
        if (owner > secondOwner) {
            ownersHighestFirst[0] = owner;
            ownersHighestFirst[1] = secondOwner;
        } else {
            ownersHighestFirst[0] = secondOwner;
            ownersHighestFirst[1] = owner;
        }
        Safe sharedSafe = new DeploySafe().deploySafe(ownersHighestFirst);
        NetworkMemberRegistry sharedRegistry = new NetworkMemberRegistry(address(sharedSafe));
        ApprovedIssuerSet sharedIssuerSet = new ApprovedIssuerSet(address(sharedRegistry));
        bytes memory setIssuerSetCall =
            abi.encodeCall(NetworkMemberRegistry.setApprovedIssuerSet, (address(sharedIssuerSet)));
        bytes memory enableModuleCall = abi.encodeCall(ModuleManager.enableModule, (networkMemberGovernance));
        uint256 setIssuerSetNonce = sharedSafe.nonce();
        uint256 enableModuleNonce = setIssuerSetNonce + 1;
        bytes32 setIssuerSetHash = sharedSafe.getTransactionHash(
            address(sharedRegistry),
            0,
            setIssuerSetCall,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            address(0),
            setIssuerSetNonce
        );
        bytes32 enableModuleHash = sharedSafe.getTransactionHash(
            address(sharedSafe),
            0,
            enableModuleCall,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            address(0),
            enableModuleNonce
        );
        vm.startPrank(secondOwner);
        sharedSafe.approveHash(setIssuerSetHash);
        sharedSafe.approveHash(enableModuleHash);
        vm.stopPrank();

        configureGovernanceScript.configureGovernance(
            sharedSafe, owner, sharedRegistry, address(sharedIssuerSet), networkMemberGovernance
        );

        address registryIssuerSet = address(sharedRegistry.approvedIssuerSet());
        bool governanceModuleIsEnabled = sharedSafe.isModuleEnabled(networkMemberGovernance);
        assertEq(registryIssuerSet, address(sharedIssuerSet));
        assertTrue(governanceModuleIsEnabled);
    }
}
