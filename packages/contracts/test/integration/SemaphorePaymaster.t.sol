// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";
import { EntryPoint } from "@account-abstraction/contracts/core/EntryPoint.sol";
import { IEntryPoint } from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import { Simple7702Account } from "@account-abstraction/contracts/accounts/Simple7702Account.sol";
import { BaseAccount } from "@account-abstraction/contracts/core/BaseAccount.sol";
import { PackedUserOperation } from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import { SemaphoreVerifier } from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import { ISemaphore } from "@semaphore-protocol/contracts/interfaces/ISemaphore.sol";

import { SemaphorePaymaster } from "../../src/SemaphorePaymaster.sol";
import { TestBase } from "../utils/TestBase.sol";

contract SemaphorePaymasterIntegrationTest is TestBase {
    EntryPoint entryPoint;
    SemaphoreVerifier semaphoreVerifier;
    SemaphorePaymaster semaphorePaymaster;

    Simple7702Account simple7702Account;

    Vm.Wallet account;
    address owner;
    address payable bundler;
    address recipient;

    uint256 constant MAX_COST_PER_OP = 0.05 ether;

    function setUp() public {
        owner = makeAddr("owner");
        vm.deal(owner, 1 ether);
        bundler = payable(makeAddr("bundler"));
        recipient = makeAddr("recipient");

        // deploy Simple7702Account account
        simple7702Account = new Simple7702Account();

        // deploy entrypoint
        entryPoint = EntryPoint(payable(address(simple7702Account.entryPoint())));
        deployCodeTo("EntryPoint.sol:EntryPoint", address(entryPoint));

        // deploy semaphore verifier
        semaphoreVerifier = new SemaphoreVerifier();

        // deploy paymaster
        semaphorePaymaster =
            new SemaphorePaymaster(address(entryPoint), address(semaphoreVerifier), owner, MAX_COST_PER_OP);

        // fund paymaster
        semaphorePaymaster.deposit{ value: 1 ether }();

        // stake paymaster
        vm.prank(owner);
        semaphorePaymaster.addStake{ value: 1 ether }(1);

        // create EOA account
        account = vm.createWallet("account");
        vm.deal(account.addr, 1 ether);

        // sign authorisation
        vm.signAndAttachDelegation(address(simple7702Account), account.privateKey);
    }

    function _generateSemaphoreProof(address _account, uint256 _accountPrivateKey) internal returns (bytes memory) {
        string[] memory scriptArgs = new string[](4);
        scriptArgs[0] = "node";
        scriptArgs[1] = "test/utils/generateSemaphoreProof.ts";
        scriptArgs[2] = vm.toString(_account);
        scriptArgs[3] = vm.toString(_accountPrivateKey);
        return vm.ffi(scriptArgs);
    }

    function _generateIdentityCommitment(uint256 _accountPrivateKey) internal returns (uint256) {
        string[] memory scriptArgs = new string[](3);
        scriptArgs[0] = "node";
        scriptArgs[1] = "test/utils/generateIdentityCommitment.ts";
        scriptArgs[2] = vm.toString(_accountPrivateKey);
        return abi.decode(vm.ffi(scriptArgs), (uint256));
    }

    function _packUints(uint256 high, uint256 low) internal pure returns (bytes32) {
        return bytes32((high << 128) | low);
    }

    function _buildUserOp(bytes memory proof) internal view returns (PackedUserOperation memory userOp) {
        uint128 verificationGasLimit = 400_000;
        uint128 callGasLimit = 200_000;
        uint128 maxPriorityFeePerGas = 1 gwei;
        uint128 maxFeePerGas = 1 gwei;
        uint128 paymasterVerificationGasLimit = 600_000;
        uint128 paymasterPostOpGasLimit = 0;

        userOp.sender = account.addr;
        userOp.nonce = entryPoint.getNonce(account.addr, 0);
        userOp.callData = abi.encodeCall(BaseAccount.execute, (recipient, 0.1 ether, ""));
        userOp.accountGasLimits = _packUints(verificationGasLimit, callGasLimit);
        userOp.preVerificationGas = 100_000;
        userOp.gasFees = _packUints(maxPriorityFeePerGas, maxFeePerGas);
        userOp.paymasterAndData = abi.encodePacked(
            address(semaphorePaymaster), paymasterVerificationGasLimit, paymasterPostOpGasLimit, proof
        );
    }

    function _signUserOp(PackedUserOperation memory userOp) internal view {
        bytes32 userOpHash = entryPoint.getUserOpHash(userOp);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(account.privateKey, userOpHash);
        userOp.signature = abi.encodePacked(r, s, v);
    }

    function test_SemaphorePaymaster_Sponsors7702UserOperation() public {
        uint256 identityCommitment = _generateIdentityCommitment(account.privateKey);

        // join semaphore group
        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.addMember(groupId, identityCommitment);

        // generate proof
        bytes memory proof = _generateSemaphoreProof(account.addr, account.privateKey);

        // generate user operation
        PackedUserOperation memory userOp = _buildUserOp(proof);
        _signUserOp(userOp);

        // send user operation
        uint256 paymasterDepositBefore = semaphorePaymaster.getDeposit();
        uint256 accountBalanceBefore = account.addr.balance;

        PackedUserOperation[] memory userOps = new PackedUserOperation[](1);
        userOps[0] = userOp;
        vm.prank(bundler);
        entryPoint.handleOps(userOps, bundler);

        assertEq(recipient.balance, 0.1 ether, "callData should have executed");
        assertEq(account.addr.balance, accountBalanceBefore - 0.1 ether, "account should pay no gas");

        // bundler starts with balance 0, and receives amount paid from paymaster despoit
        assertEq(
            paymasterDepositBefore - semaphorePaymaster.getDeposit(),
            bundler.balance,
            "paymaster deposit should have paid the bundler exactly"
        );
    }

    function test_SemaphorePaymaster_HashesMessageAndScopeLikeSemaphore() public {
        uint256 identityCommitment = _generateIdentityCommitment(account.privateKey);
        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.addMember(groupId, identityCommitment);

        bytes memory proof = _generateSemaphoreProof(account.addr, account.privateKey);
        ISemaphore.SemaphoreProof memory decodedProof = abi.decode(proof, (ISemaphore.SemaphoreProof));
        bool acceptedBySemaphore = semaphorePaymaster.verifyProof(groupId, decodedProof);

        PackedUserOperation memory userOp = _buildUserOp(proof);
        vm.prank(address(entryPoint));
        (, uint256 validationData) = semaphorePaymaster.validatePaymasterUserOp(userOp, bytes32(0), MAX_COST_PER_OP);

        assertTrue(acceptedBySemaphore, "Semaphore's own verifyProof must accept the proof");
        assertEq(validationData, 0, "The paymaster must accept what Semaphore accepts, so _hashToField matches _hash");
    }

    function test_SemaphorePaymaster_RevertsWhen_PreVerificationGasInflated() public {
        uint256 identityCommitment = _generateIdentityCommitment(account.privateKey);

        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.addMember(groupId, identityCommitment);

        bytes memory proof = _generateSemaphoreProof(account.addr, account.privateKey);

        // preVerificationGas is charged in full and paid to the bundler, so a member could
        // otherwise drain the deposit into an address they control. This op's maxCost
        // exceeds MAX_COST_PER_OP
        PackedUserOperation memory userOp = _buildUserOp(proof);
        userOp.preVerificationGas = 200_000_000;
        _signUserOp(userOp);

        PackedUserOperation[] memory userOps = new PackedUserOperation[](1);
        userOps[0] = userOp;

        uint256 paymasterDepositBefore = semaphorePaymaster.getDeposit();

        vm.expectRevert(abi.encodeWithSelector(IEntryPoint.FailedOp.selector, uint256(0), "AA34 signature error"));
        vm.prank(bundler);
        entryPoint.handleOps(userOps, bundler);

        assertEq(semaphorePaymaster.getDeposit(), paymasterDepositBefore, "The deposit must be untouched");
    }

    function test_SemaphorePaymaster_RevertsWhen_SupersededRootExpired() public {
        uint256 identityCommitment = _generateIdentityCommitment(account.privateKey);

        uint256 groupId = semaphorePaymaster.GROUP_ID();
        vm.prank(owner);
        semaphorePaymaster.addMember(groupId, identityCommitment);

        bytes memory proof = _generateSemaphoreProof(account.addr, account.privateKey);

        // adding a second member supersedes the root the proof was generated against
        vm.prank(owner);
        semaphorePaymaster.addMember(groupId, 1);

        vm.warp(block.timestamp + 1 hours + 1 seconds);

        PackedUserOperation memory userOp = _buildUserOp(proof);
        _signUserOp(userOp);

        PackedUserOperation[] memory userOps = new PackedUserOperation[](1);
        userOps[0] = userOp;

        vm.expectRevert(
            abi.encodeWithSelector(IEntryPoint.FailedOp.selector, uint256(0), "AA32 paymaster expired or not due")
        );
        vm.prank(bundler);
        entryPoint.handleOps(userOps, bundler);
    }
}
