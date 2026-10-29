// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";
import { ISemaphoreGroups } from "@semaphore-protocol/contracts/interfaces/ISemaphoreGroups.sol";
import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";

import { DeployAll } from "../../script/DeployAll.s.sol";
import { DeploySafe } from "../../script/DeploySafe.s.sol";
import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";
import { AdmitNetworkMember } from "../../script/utils/AdmitNetworkMember.s.sol";
import { SafeTransaction } from "../../script/base/SafeTransaction.sol";
import { ConfigureGovernance } from "../../script/utils/ConfigureGovernance.s.sol";
import { CanonicalDependencies } from "../utils/CanonicalDependencies.sol";

contract AdmitNetworkMemberUnitTest is CanonicalDependencies {
    uint256 internal constant MAX_COST_PER_OP = 0.05 ether;
    uint256 internal constant NETWORK_MEMBER_COMMITMENT = 12_345;

    AdmitNetworkMember internal admitNetworkMemberScript;
    DeployAll.Deployment internal deployment;
    Safe internal governanceSafe;

    address internal owner;
    address internal networkMemberMultisigSigner;
    Vm.Wallet internal memberWallet;
    bytes internal memberAccountKey;
    bytes32 internal memberNetworkId;

    function setUp() public {
        owner = makeAddr("owner");

        DeployAll deployAllScript = new DeployAll();
        deployAllScript.setDeploymentsDirectory("deployments/test/admission");
        deployment = deployAllScript.deployAll(DEFAULT_SENDER, owner, MAX_COST_PER_OP);
        governanceSafe = deployment.governanceSafe;
        new ConfigureGovernance()
            .configureGovernance(
                governanceSafe,
                owner,
                deployment.networkMemberRegistry,
                address(deployment.approvedIssuerSet),
                address(deployment.networkMemberGovernance)
            );

        admitNetworkMemberScript = new AdmitNetworkMember();
        networkMemberMultisigSigner = makeAddr("networkMemberMultisigSigner");
        memberWallet = vm.createWallet("memberAccountKey");
        memberAccountKey = abi.encode(memberWallet.publicKeyX, memberWallet.publicKeyY);
        memberNetworkId = keccak256(abi.encodePacked(memberWallet.publicKeyX, memberWallet.publicKeyY));
    }

    function test_admitNetworkMember_putsTheCommitmentInTheApprovedMemberGroup() public {
        admitNetworkMemberScript.admitNetworkMember(
            governanceSafe,
            owner,
            deployment.networkMemberGovernance,
            memberAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            networkMemberMultisigSigner
        );

        ISemaphoreGroups semaphoreGroups = ISemaphoreGroups(DeployedThirdPartyContracts.SEMAPHORE);
        assertTrue(semaphoreGroups.hasMember(deployment.networkMemberGroup.GROUP_ID(), NETWORK_MEMBER_COMMITMENT));
        assertTrue(governanceSafe.isOwner(networkMemberMultisigSigner));
    }

    function test_admitNetworkMember_admitsTheFoundingMemberWithoutAddingASafeOwner() public {
        address alreadySafeOwner = owner;

        assertTrue(governanceSafe.isOwner(alreadySafeOwner));
        assertFalse(deployment.networkMemberRegistry.isApproved(memberNetworkId));
        assertFalse(deployment.networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));

        admitNetworkMemberScript.admitNetworkMember(
            governanceSafe,
            owner,
            deployment.networkMemberGovernance,
            memberAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            alreadySafeOwner
        );

        assertTrue(deployment.networkMemberRegistry.isApproved(memberNetworkId));
        assertTrue(deployment.networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));
        assertEq(governanceSafe.getOwners().length, 1);
        assertEq(governanceSafe.getThreshold(), 1);
    }

    function test_admitNetworkMember_skipsTheFoundingMemberRecordWhenAlreadyApproved() public {
        address alreadySafeOwner = owner;
        vm.prank(address(governanceSafe));
        deployment.networkMemberRegistry
            .approveNetworkMember(
                memberWallet.publicKeyX, memberWallet.publicKeyY, NETWORK_MEMBER_COMMITMENT, alreadySafeOwner
            );
        uint256 safeNonce = governanceSafe.nonce();

        assertTrue(governanceSafe.isOwner(alreadySafeOwner));
        assertTrue(deployment.networkMemberRegistry.isApproved(memberNetworkId));
        assertFalse(deployment.networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));

        admitNetworkMemberScript.admitNetworkMember(
            governanceSafe,
            owner,
            deployment.networkMemberGovernance,
            memberAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            alreadySafeOwner
        );

        assertTrue(deployment.networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));
        assertEq(governanceSafe.nonce(), safeNonce + 1);
    }

    function test_admitNetworkMember_skipsTheFoundingMemberLeafWhenAlreadyInTheGroup() public {
        address alreadySafeOwner = owner;
        vm.prank(address(governanceSafe));
        deployment.networkMemberGroup.addNetworkMember(NETWORK_MEMBER_COMMITMENT);
        uint256 safeNonce = governanceSafe.nonce();

        assertTrue(governanceSafe.isOwner(alreadySafeOwner));
        assertTrue(deployment.networkMemberGroup.hasNetworkMember(NETWORK_MEMBER_COMMITMENT));
        assertFalse(deployment.networkMemberRegistry.isApproved(memberNetworkId));

        admitNetworkMemberScript.admitNetworkMember(
            governanceSafe,
            owner,
            deployment.networkMemberGovernance,
            memberAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            alreadySafeOwner
        );

        assertTrue(deployment.networkMemberRegistry.isApproved(memberNetworkId));
        assertEq(governanceSafe.nonce(), safeNonce + 1);
    }

    function test_admitNetworkMember_aSecondFoundingRunChangesNothing() public {
        address alreadySafeOwner = owner;

        assertTrue(governanceSafe.isOwner(alreadySafeOwner));

        admitNetworkMemberScript.admitNetworkMember(
            governanceSafe,
            owner,
            deployment.networkMemberGovernance,
            memberAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            alreadySafeOwner
        );
        uint256 safeNonce = governanceSafe.nonce();

        admitNetworkMemberScript.admitNetworkMember(
            governanceSafe,
            owner,
            deployment.networkMemberGovernance,
            memberAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            alreadySafeOwner
        );

        assertEq(governanceSafe.nonce(), safeNonce);
    }

    function test_admitNetworkMember_revertsWhen_OwnerDoesNotOwnTheSafe() public {
        address[] memory owners = new address[](1);
        owners[0] = makeAddr("someoneElse");
        Safe otherSafe = new DeploySafe().deploySafe(owners);

        vm.expectRevert(abi.encodeWithSelector(SafeTransaction.NotASafeOwner.selector, owner));
        admitNetworkMemberScript.admitNetworkMember(
            otherSafe,
            owner,
            deployment.networkMemberGovernance,
            memberAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            networkMemberMultisigSigner
        );
    }

    function test_admitNetworkMember_revertsWhenTheOtherOwnersHaveNotApproved() public {
        address[] memory owners = new address[](3);
        owners[0] = owner;
        owners[1] = makeAddr("secondOwner");
        owners[2] = makeAddr("thirdOwner");
        Safe sharedSafe = new DeploySafe().deploySafe(owners);

        vm.expectRevert(abi.encodeWithSelector(SafeTransaction.NotEnoughApprovals.selector, 1, 2));
        admitNetworkMemberScript.admitNetworkMember(
            sharedSafe,
            owner,
            deployment.networkMemberGovernance,
            memberAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            networkMemberMultisigSigner
        );
    }

    function test_admitNetworkMember_revertsWhen_AccountKeyIsNot64Bytes() public {
        bytes1 uncompressedKeyPrefix = 0x04;
        bytes memory uncompressedAccountKey =
            abi.encodePacked(uncompressedKeyPrefix, memberWallet.publicKeyX, memberWallet.publicKeyY);
        bytes memory keyLengthError = bytes("MEMBER_ACCOUNT_PUBLIC_KEY must be 64 bytes: X || Y");

        vm.expectRevert(keyLengthError);
        admitNetworkMemberScript.admitNetworkMember(
            governanceSafe,
            owner,
            deployment.networkMemberGovernance,
            uncompressedAccountKey,
            NETWORK_MEMBER_COMMITMENT,
            networkMemberMultisigSigner
        );
    }
}
