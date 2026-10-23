// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { IStakeManager } from "@account-abstraction/contracts/interfaces/IStakeManager.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { DeployAndConfigureAll } from "../../script/DeployAndConfigureAll.s.sol";
import { DeployApprovedIssuerSet } from "../../script/DeployApprovedIssuerSet.s.sol";
import { DeployCredentialRevocationRegistry } from "../../script/DeployCredentialRevocationRegistry.s.sol";
import { DeploySafe } from "../../script/DeploySafe.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { DeployIdentityRegistry } from "../../script/DeployIdentityRegistry.s.sol";
import { DeployNetworkMemberGovernance } from "../../script/DeployNetworkMemberGovernance.s.sol";
import { DeployNetworkMemberGroup } from "../../script/DeployNetworkMemberGroup.s.sol";
import { DeployNetworkMemberRegistry } from "../../script/DeployNetworkMemberRegistry.s.sol";
import { DeployRevocation } from "../../script/DeployRevocation.s.sol";
import { DeploySemaphorePaymaster } from "../../script/DeploySemaphorePaymaster.s.sol";
import { DeployTestScopedToken } from "../../script/test/DeployTestScopedToken.s.sol";
import { AddPaymasterMember } from "../../script/utils/AddPaymasterMember.s.sol";
import { AdmitNetworkMember } from "../../script/utils/AdmitNetworkMember.s.sol";
import { ConfigureGovernance } from "../../script/utils/ConfigureGovernance.s.sol";
import { CreateRevocationRegistry } from "../../script/utils/CreateRevocationRegistry.s.sol";
import { FundPaymaster } from "../../script/utils/FundPaymaster.s.sol";
import { WithdrawPaymasterDeposit } from "../../script/utils/WithdrawPaymasterDeposit.s.sol";
import { WithdrawPaymasterStake } from "../../script/utils/WithdrawPaymasterStake.s.sol";
import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { NetworkMemberGovernance } from "../../src/NetworkMemberGovernance.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { Revocation } from "../../src/revocation/Revocation.sol";
import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract DeployScriptsIntegrationTest is NetworkMemberRegistryTestBase {
    uint256 internal constant MAX_COST_PER_OP = 0.05 ether;
    uint256 internal constant PAYMASTER_DEPOSIT = 0.2 ether;
    uint256 internal constant PAYMASTER_STAKE = 1 ether;
    uint32 internal constant PAYMASTER_UNSTAKE_DELAY = 1 days;
    uint256 internal constant NETWORK_MEMBER_COMMITMENT = 12_345;

    function test_run_everyScriptReadsItsOwnEnvironmentVariables() public {
        // 1. Accounts and Safe the scripts use.
        address revocationAdmin = makeAddr("revocationAdmin");
        address payable withdrawTo = payable(makeAddr("withdrawTo"));
        vm.deal(owner, 10 ether);
        vm.setEnv("DEPLOYER", vm.toString(DEFAULT_SENDER));
        vm.setEnv("OWNER", vm.toString(owner));
        safe = new DeploySafe().run();

        // 2. Initial vars known before any deployments.
        vm.setEnv("GOVERNANCE_SAFE", vm.toString(address(safe)));
        vm.setEnv("MAX_COST_PER_OP", vm.toString(MAX_COST_PER_OP));
        vm.setEnv("REVOCATION_ADMIN", vm.toString(revocationAdmin));
        vm.setEnv("PAYMASTER_DEPOSIT", vm.toString(PAYMASTER_DEPOSIT));
        vm.setEnv("PAYMASTER_STAKE", vm.toString(PAYMASTER_STAKE));
        vm.setEnv("PAYMASTER_WITHDRAW_TO", vm.toString(withdrawTo));
        vm.setEnv("PAYMASTER_UNSTAKE_DELAY", vm.toString(uint256(PAYMASTER_UNSTAKE_DELAY)));

        // 3. Registry and member group
        NetworkMemberRegistry networkMemberRegistry = new DeployNetworkMemberRegistry().run();
        NetworkMemberGroup networkMemberGroup = new DeployNetworkMemberGroup().run();
        assertEq(networkMemberRegistry.owner(), address(safe));
        assertEq(networkMemberGroup.owner(), address(safe));

        // 4. Registry and group addresses
        vm.setEnv("NETWORK_MEMBER_REGISTRY", vm.toString(address(networkMemberRegistry)));
        vm.setEnv("NETWORK_MEMBER_GROUP", vm.toString(address(networkMemberGroup)));
        vm.setEnv("NETWORK_MEMBER_GROUP_ID", vm.toString(networkMemberGroup.GROUP_ID()));

        // 5. Governance, issuer set, identity registry and test token.
        DeployAll.Deployment memory deployment = new DeployAll().run();
        assertEq(address(deployment.governanceSafe), address(safe));
        assertEq(address(deployment.networkMemberRegistry), address(networkMemberRegistry));
        NetworkMemberGovernance networkMemberGovernance = new DeployNetworkMemberGovernance().run();
        assertEq(address(networkMemberGovernance.REGISTRY()), address(networkMemberRegistry));
        ApprovedIssuerSet approvedIssuerSet = new DeployApprovedIssuerSet().run();
        assertEq(approvedIssuerSet.memberRegistry(), address(networkMemberRegistry));
        assertEq(new DeployIdentityRegistry().run().NETWORK_MEMBER_GROUP_ID(), networkMemberGroup.GROUP_ID());
        assertGt(address(new DeployTestScopedToken().run()).code.length, 0);

        // 6. The two governance transactions that make the deployment usable.
        vm.setEnv("APPROVED_ISSUER_SET", vm.toString(address(approvedIssuerSet)));
        vm.setEnv("NETWORK_MEMBER_GOVERNANCE", vm.toString(address(networkMemberGovernance)));
        new ConfigureGovernance().run();
        assertEq(address(networkMemberRegistry.approvedIssuerSet()), address(approvedIssuerSet));
        assertTrue(safe.isModuleEnabled(address(networkMemberGovernance)));

        // 7. Admit the network member the end-to-end run acts as.
        address networkMemberMultisigSigner = makeAddr("networkMemberMultisigSigner");
        vm.setEnv(
            "MEMBER_ACCOUNT_PUBLIC_KEY",
            vm.toString(abi.encodePacked(networkMember.publicKeyX, networkMember.publicKeyY))
        );
        vm.setEnv("NETWORK_MEMBER_COMMITMENT", vm.toString(NETWORK_MEMBER_COMMITMENT));
        vm.setEnv("NETWORK_MEMBER_MULTISIG_SIGNER", vm.toString(networkMemberMultisigSigner));
        new AdmitNetworkMember().run();
        assertTrue(safe.isOwner(networkMemberMultisigSigner));
        assertTrue(networkMemberRegistry.isApproved(memberNetworkId));
        assertTrue(networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));

        // 8. Revocation + create a registry.
        Revocation revocation = new DeployRevocation().run();
        vm.setEnv("REVOCATION", vm.toString(address(revocation)));
        uint256 revocationRegistryId = new CreateRevocationRegistry().run();
        assertEq(revocation.getRegistryAdmin(revocationRegistryId), revocationAdmin);
        assertEq(address(new DeployCredentialRevocationRegistry().run().REVOCATION()), address(revocation));

        // 9. Paymaster + funding and withdrawing scripts
        SemaphorePaymaster semaphorePaymaster = new DeploySemaphorePaymaster().run();
        vm.setEnv("SEMAPHORE_PAYMASTER", vm.toString(address(semaphorePaymaster)));
        assertEq(new FundPaymaster().run(), PAYMASTER_DEPOSIT);
        new AddPaymasterMember().run();
        assertTrue(semaphorePaymaster.hasMember(semaphorePaymaster.GROUP_ID(), NETWORK_MEMBER_COMMITMENT));
        assertEq(new WithdrawPaymasterDeposit().run(), PAYMASTER_DEPOSIT);

        // 10. Withdraw paymaster stake once delay has passed.
        vm.warp(block.timestamp + PAYMASTER_UNSTAKE_DELAY);
        new WithdrawPaymasterStake().run();
        assertEq(withdrawTo.balance, PAYMASTER_DEPOSIT + PAYMASTER_STAKE);
    }

    function test_run_deployAndConfigureAllReadsItsOwnEnvironmentVariables() public {
        vm.deal(owner, 10 ether);
        vm.setEnv("DEPLOYER", vm.toString(DEFAULT_SENDER));
        vm.setEnv("OWNER", vm.toString(owner));
        vm.setEnv("MAX_COST_PER_OP", vm.toString(MAX_COST_PER_OP));
        vm.setEnv("PAYMASTER_DEPOSIT", vm.toString(PAYMASTER_DEPOSIT));
        vm.setEnv("PAYMASTER_STAKE", vm.toString(PAYMASTER_STAKE));
        vm.setEnv("PAYMASTER_UNSTAKE_DELAY", vm.toString(uint256(PAYMASTER_UNSTAKE_DELAY)));
        vm.setEnv(
            "MEMBER_ACCOUNT_PUBLIC_KEY",
            vm.toString(abi.encodePacked(networkMember.publicKeyX, networkMember.publicKeyY))
        );
        vm.setEnv("NETWORK_MEMBER_COMMITMENT", vm.toString(NETWORK_MEMBER_COMMITMENT));

        DeployAll.Deployment memory deployment = new DeployAndConfigureAll().run();

        IStakeManager.DepositInfo memory funded =
            IEntryPoint(DeployedThirdPartyContracts.ENTRY_POINT).getDepositInfo(address(deployment.semaphorePaymaster));
        assertFalse(deployment.governanceSafe.isOwner(DEFAULT_SENDER));
        assertTrue(deployment.governanceSafe.isOwner(owner));
        assertEq(deployment.semaphorePaymaster.MAX_COST_PER_OP(), MAX_COST_PER_OP);
        assertEq(funded.deposit, PAYMASTER_DEPOSIT);
        assertEq(funded.stake, PAYMASTER_STAKE);
        assertEq(funded.unstakeDelaySec, PAYMASTER_UNSTAKE_DELAY);
        assertTrue(deployment.networkMemberRegistry.isApproved(memberNetworkId));
        assertTrue(deployment.networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));
        assertTrue(
            deployment.semaphorePaymaster.hasMember(deployment.semaphorePaymaster.GROUP_ID(), NETWORK_MEMBER_COMMITMENT)
        );
    }
}
