// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Test, Vm } from "forge-std/Test.sol";

import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";
import { Enum } from "@safe-global/safe-smart-account/contracts/libraries/Enum.sol";
import { MultiSendCallOnly } from "@safe-global/safe-smart-account/contracts/libraries/MultiSendCallOnly.sol";
import { SafeProxyFactory } from "@safe-global/safe-smart-account/contracts/proxies/SafeProxyFactory.sol";

/// @dev Deploys and drives a real governance Safe: the Safe singleton, a proxy factory, a proxy set
/// up with `n` owners at threshold `t`, and MultiSendCallOnly for batching.
/// @dev These are the Safe team's own contracts, so a transaction that executes here is one that
/// executes against a production Safe: the same `getTransactionHash` digest, the same
/// `checkNSignatures` rules, the same MultiSend batching. Signatures are packed exactly as the
/// `network-member-governance` package builds them, 65 bytes per owner ordered by ascending signer
/// address.
abstract contract SafeGovernanceFixture is Test {
    Safe internal safe;
    MultiSendCallOnly internal multiSend;

    /// @dev The Safe's owner wallets, sorted ascending by address so the signing loop can walk them.
    Vm.Wallet[] internal safeSigners;

    /// @dev The network's governance rule: a majority of the members, one more than half.
    /// @param memberCount How many members the Safe has owners for.
    /// @return The required number of signatures.
    function _governanceThreshold(uint256 memberCount) internal pure returns (uint256) {
        return memberCount / 2 + 1;
    }

    /// @dev Deploys a Safe with `signerCount` owners at the majority threshold.
    /// @param signerCount How many owners the Safe has.
    function _deployGovernanceSafe(uint256 signerCount) internal returns (Safe) {
        return _deployGovernanceSafe(signerCount, _governanceThreshold(signerCount));
    }

    /// @dev Deploys a Safe with `signerCount` owners requiring `threshold` signatures.
    /// @param signerCount How many owners the Safe has.
    /// @param threshold How many of them must sign.
    function _deployGovernanceSafe(uint256 signerCount, uint256 threshold) internal returns (Safe) {
        Vm.Wallet[] memory signers = new Vm.Wallet[](signerCount);
        for (uint256 i = 0; i < signerCount; ++i) {
            signers[i] = vm.createWallet(string.concat("owner", vm.toString(i)));
        }

        // A Safe wants its signatures ordered by ascending signer address.
        for (uint256 i = 1; i < signerCount; ++i) {
            for (uint256 j = i; j > 0 && signers[j - 1].addr > signers[j].addr; --j) {
                Vm.Wallet memory swap = signers[j - 1];
                signers[j - 1] = signers[j];
                signers[j] = swap;
            }
        }

        address[] memory owners = new address[](signerCount);
        delete safeSigners;
        for (uint256 i = 0; i < signerCount; ++i) {
            owners[i] = signers[i].addr;
            safeSigners.push(signers[i]);
        }

        multiSend = new MultiSendCallOnly();
        Safe singleton = new Safe();
        SafeProxyFactory factory = new SafeProxyFactory();

        bytes memory setup = abi.encodeCall(
            Safe.setup, (owners, threshold, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        safe = Safe(payable(address(factory.createProxyWithNonce(address(singleton), setup, 0))));

        return safe;
    }

    /// @dev The owner preceding `owner` in the Safe's owner linked list. The sentinel precedes the
    /// first owner.
    /// @param owner The owner to look up.
    function _prevOwnerOf(address owner) internal view returns (address) {
        address[] memory owners = safe.getOwners();

        for (uint256 i = 0; i < owners.length; ++i) {
            if (owners[i] == owner) return i == 0 ? address(0x1) : owners[i - 1];
        }

        revert("not an owner");
    }

    /// @dev The digest an approver records with `approveHash`, for a plain call from the Safe.
    /// @param to The contract the Safe would call.
    /// @param data The calldata.
    function _safeTransactionHash(address to, bytes memory data) internal view returns (bytes32) {
        return safe.getTransactionHash(to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), address(0), safe.nonce());
    }

    /// @dev Records owner `index`'s approval of `txHash` in the Safe's own storage, from its own key.
    /// @param index The owner's position in the ascending owner list.
    /// @param txHash The digest to approve.
    function _approveHashAsOwner(uint256 index, bytes32 txHash) internal {
        vm.prank(safeSigners[index].addr);
        safe.approveHash(txHash);
    }

    /// @dev Signature entries for owners that approved on chain: 65 bytes each, `r` the owner address,
    /// `s` empty and `v` of 1, ordered ascending. The Safe reads `v == 1` and looks the approval up in
    /// its storage instead of recovering a signature.
    /// @param indices The owners to name, in ascending order.
    function _onChainApprovals(uint256[] memory indices) internal view returns (bytes memory signatures) {
        for (uint256 i = 0; i < indices.length; ++i) {
            signatures = abi.encodePacked(
                signatures, bytes32(uint256(uint160(safeSigners[indices[i]].addr))), bytes32(0), uint8(1)
            );
        }
    }

    /// @dev Enables a Safe module, which takes a quorum like any other governance change.
    /// @param module The module to enable.
    function _enableSafeModule(address module) internal {
        _execFromSafe(address(safe), abi.encodeWithSignature("enableModule(address)", module), safe.getThreshold());
    }

    /// @dev Signatures over a plain call from the first `signatureCount` owners.
    function _signForSafe(address to, bytes memory data, uint256 signatureCount) internal view returns (bytes memory) {
        return _signForSafe(to, data, Enum.Operation.Call, signatureCount);
    }

    /// @dev Signatures over a Safe transaction from the first `signatureCount` owners, packed as the
    /// Safe wants them: 65 bytes each, ordered by ascending signer.
    /// @param to The contract the Safe calls.
    /// @param data The calldata.
    /// @param operation Call, or DelegateCall for a MultiSend batch.
    /// @param signatureCount How many owners sign.
    function _signForSafe(address to, bytes memory data, Enum.Operation operation, uint256 signatureCount)
        internal
        view
        returns (bytes memory signatures)
    {
        bytes32 digest = safe.getTransactionHash(to, 0, data, operation, 0, 0, 0, address(0), address(0), safe.nonce());

        for (uint256 i = 0; i < signatureCount; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(safeSigners[i], digest);
            signatures = abi.encodePacked(signatures, r, s, v);
        }
    }

    /// @dev Executes a Safe transaction signed by the first `signatureCount` owners.
    function _execFromSafe(address to, bytes memory data, Enum.Operation operation, uint256 signatureCount)
        internal
        returns (bool)
    {
        return _execSignedFromSafe(to, data, operation, _signForSafe(to, data, operation, signatureCount));
    }

    /// @dev Executes a Safe transaction with already-collected signatures. Split out from
    /// {_execFromSafe} because `execTransaction` takes ten arguments and the legacy pipeline runs out
    /// of stack if anything else shares the frame.
    function _execSignedFromSafe(address to, bytes memory data, Enum.Operation operation, bytes memory signatures)
        internal
        returns (bool)
    {
        return safe.execTransaction(to, 0, data, operation, 0, 0, 0, address(0), payable(address(0)), signatures);
    }

    /// @dev Executes a plain call from the Safe.
    function _execFromSafe(address to, bytes memory data, uint256 signatureCount) internal returns (bool) {
        return _execFromSafe(to, data, Enum.Operation.Call, signatureCount);
    }

    /// @dev The `multiSend` calldata for a batch of plain calls.
    function _multiSendPayload(address[] memory targets, bytes[] memory calls) internal pure returns (bytes memory) {
        bytes memory packed;
        for (uint256 i = 0; i < targets.length; ++i) {
            packed = abi.encodePacked(packed, uint8(0), targets[i], uint256(0), calls[i].length, calls[i]);
        }

        return abi.encodeCall(MultiSendCallOnly.multiSend, (packed));
    }

    /// @dev Executes several calls from the Safe as one MultiSendCallOnly batch, the way the
    /// governance package builds an admission or a removal: all of them land, or none do.
    function _execBatchFromSafe(address[] memory targets, bytes[] memory calls, uint256 signatureCount)
        internal
        returns (bool)
    {
        return _execFromSafe(
            address(multiSend), _multiSendPayload(targets, calls), Enum.Operation.DelegateCall, signatureCount
        );
    }

    /// @dev The same call, signed by the *last* `signatureCount` owners rather than the first, so a
    /// test can show that a freshly added owner really is part of a working quorum.
    function _execFromSafeWithLastSigners(address to, bytes memory data, uint256 signatureCount)
        internal
        returns (bool)
    {
        bytes32 digest = safe.getTransactionHash(
            to, 0, data, Enum.Operation.Call, 0, 0, 0, address(0), address(0), safe.nonce()
        );

        bytes memory signatures;
        for (uint256 i = safeSigners.length - signatureCount; i < safeSigners.length; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(safeSigners[i], digest);
            signatures = abi.encodePacked(signatures, r, s, v);
        }

        return _execSignedFromSafe(to, data, Enum.Operation.Call, signatures);
    }
}
