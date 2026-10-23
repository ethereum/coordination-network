// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";

import { Semaphore } from "@semaphore-protocol/contracts/Semaphore.sol";
import { SemaphoreVerifier } from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import { ISemaphoreVerifier } from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

import { ApprovedIssuerSet } from "../../src/ApprovedIssuerSet.sol";
import { NetworkMemberGroup } from "../../src/NetworkMemberGroup.sol";
import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { BabyJubjubTestKeys } from "./BabyJubjubTestKeys.sol";
import { SafeGovernanceFixture } from "./SafeGovernanceFixture.sol";
import { TestBase } from "./TestBase.sol";

abstract contract NetworkMemberRegistryTestBase is TestBase, SafeGovernanceFixture, BabyJubjubTestKeys {
    /// @dev The order of the Baby Jubjub scalar field, the range a Semaphore commitment lives in.
    uint256 internal constant SNARK_SCALAR_FIELD =
        21_888_242_871_839_275_222_246_405_745_257_275_088_548_364_400_416_034_343_698_204_186_575_808_495_617;

    NetworkMemberRegistry public registry;
    ApprovedIssuerSet public issuerSet;

    address owner;
    Vm.Wallet networkMember;
    bytes32 memberNetworkId;
    bytes metaStealthAddress;
    uint256 semaphoreCommitment;
    address governanceSigner;

    function setUp() public {
        owner = makeAddr("governance");
        registry = new NetworkMemberRegistry(owner);
        issuerSet = new ApprovedIssuerSet(address(registry));

        vm.prank(owner);
        registry.setApprovedIssuerSet(address(issuerSet));

        networkMember = vm.createWallet("networkMember");
        memberNetworkId = keccak256(abi.encodePacked(networkMember.publicKeyX, networkMember.publicKeyY));
        metaStealthAddress = _generateStealthMetaAddress(networkMember);
        semaphoreCommitment = _semaphoreCommitment("networkMember");
        governanceSigner = makeAddr("networkMemberGovernanceSigner");
    }

    /// @dev A stand-in Semaphore identity commitment: any field element is a valid leaf, and no test
    /// here proves membership, so there is no need to derive one from a Baby Jubjub key.
    function _semaphoreCommitment(string memory seed) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("semaphore commitment", seed))) % SNARK_SCALAR_FIELD;
    }

    function _approveMember() internal {
        vm.prank(owner);
        registry.approveNetworkMember(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner
        );
    }

    function _removeMember() internal {
        vm.prank(owner);
        registry.removeNetworkMember(memberNetworkId);
    }

    /// @dev A real Semaphore deployment, so the group behaves exactly as it will in production.
    function _deploySemaphore() internal returns (Semaphore) {
        return new Semaphore(ISemaphoreVerifier(address(new SemaphoreVerifier())));
    }

    /// @dev A member group whose Semaphore group is created at deployment, owned by `governance`.
    function _deployNetworkMemberGroup(address governance) internal returns (NetworkMemberGroup) {
        return new NetworkMemberGroup(_deploySemaphore(), governance);
    }
}
