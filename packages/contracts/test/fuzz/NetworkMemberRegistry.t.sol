// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { NetworkMemberRegistry } from "../../src/NetworkMemberRegistry.sol";
import { NetworkMemberRegistryTestBase } from "../utils/NetworkMemberRegistryTestBase.sol";

contract NetworkMemberRegistryFuzzTest is NetworkMemberRegistryTestBase {
    function testFuzz_RegisterNetworkMemberIdentity_StoresValidMeta(bytes32 spendingKey, bytes32 viewingKey) public {
        _approveMember();
        bytes memory metaStealth = abi.encodePacked(bytes1(0x02), spendingKey, bytes1(0x03), viewingKey);

        vm.prank(networkMember.addr);
        registry.registerNetworkMemberIdentity(memberNetworkId, metaStealth);

        assertEq(registry.identity(memberNetworkId), metaStealth);
    }

    function testFuzz_RegisterNetworkMemberIdentity_RevertsWhen_WrongLength(bytes calldata wrongLengthMeta) public {
        vm.assume(wrongLengthMeta.length != registry.META_STEALTH_ADDRESS_LENGTH());
        _approveMember();

        vm.expectRevert(NetworkMemberRegistry.InvalidMetaStealthAddressLength.selector);
        vm.prank(networkMember.addr);
        registry.registerNetworkMemberIdentity(memberNetworkId, wrongLengthMeta);
    }

    function testFuzz_ApproveNetworkMember_RecordsAnyNonZeroCommitment(uint256 commitment) public {
        commitment = bound(commitment, 1, type(uint256).max);

        vm.prank(owner);
        registry.approveNetworkMember(networkMember.publicKeyX, networkMember.publicKeyY, commitment, governanceSigner);

        assertEq(registry.semaphoreCommitmentOf(memberNetworkId), commitment);
    }

    function testFuzz_RequestToJoin_RevertsWhen_CallerIsNotTheNetworkIdKey(address caller) public {
        vm.assume(caller != address(uint160(uint256(memberNetworkId))));

        vm.expectRevert(NetworkMemberRegistry.UnauthorizedCaller.selector);
        vm.prank(caller);
        registry.requestToJoin(
            networkMember.publicKeyX, networkMember.publicKeyY, semaphoreCommitment, governanceSigner, ""
        );
    }

    function testFuzz_ApproveNetworkMember_RevertsWhen_KeyIsNotOnTheCurve(uint256 x, uint256 y) public {
        vm.assume(!_isOnCurve(x, y));

        vm.expectRevert(NetworkMemberRegistry.AccountKeyNotOnCurve.selector);
        vm.prank(owner);
        registry.approveNetworkMember(x, y, semaphoreCommitment, governanceSigner);
    }

    function testFuzz_RequestToJoin_RevertsWhen_KeyIsNotOnTheCurve(uint256 x, uint256 y) public {
        vm.assume(!_isOnCurve(x, y));

        vm.expectRevert(NetworkMemberRegistry.AccountKeyNotOnCurve.selector);
        vm.prank(networkMember.addr);
        registry.requestToJoin(x, y, semaphoreCommitment, governanceSigner, "");
    }

    function _isOnCurve(uint256 x, uint256 y) internal pure returns (bool) {
        uint256 p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F;
        return x < p && y < p && mulmod(y, y, p) == addmod(mulmod(mulmod(x, x, p), x, p), 7, p);
    }
}
