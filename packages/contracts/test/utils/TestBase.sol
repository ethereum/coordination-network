// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";

import { CanonicalDependencies } from "./CanonicalDependencies.sol";

/// @dev Shared test logic
abstract contract TestBase is CanonicalDependencies {
    struct PubKey {
        uint256 x;
        uint256 y;
    }

    /// ERC-6538 scheme 1 meta-address: the compressed spending pubkey and viewing
    /// pubkey concatenated, 33 bytes each.
    function _generateStealthMetaAddress(Vm.Wallet memory identity) internal returns (bytes memory) {
        // Keys derived as in fluidkey generateKeysFromSignature: the identity key signs a
        // fixed message, then each 32-byte half of the signature (r, s) is keccak256-hashed
        // into a private key.
        // https://github.com/fluidkey/fluidkey-stealth-account-kit/blob/main/src/generateKeysFromSignature.ts
        (, bytes32 r, bytes32 s) = vm.sign(identity, keccak256("stealth key derivation"));
        Vm.Wallet memory spendingWallet = vm.createWallet(uint256(keccak256(abi.encodePacked(r))));
        Vm.Wallet memory viewingWallet = vm.createWallet(uint256(keccak256(abi.encodePacked(s))));
        PubKey memory spending = PubKey(spendingWallet.publicKeyX, spendingWallet.publicKeyY);
        PubKey memory viewing = PubKey(viewingWallet.publicKeyX, viewingWallet.publicKeyY);

        return abi.encodePacked(_compressPublicKey(spending), _compressPublicKey(viewing));
    }

    // Each pubkey is compressed per ERC-6538 scheme 1:
    // https://eips.ethereum.org/EIPS/eip-6538
    // This compression is done by default noble-secp256k1 library:
    // https://github.com/paulmillr/noble-secp256k1/blob/f0105579e96e55d128e0b9f2007dbe29b7d340e2/index.ts#L332
    function _compressPublicKey(PubKey memory publicKey) internal pure returns (bytes memory) {
        bytes1 sec1Prefix = publicKey.y % 2 == 0 ? bytes1(0x02) : bytes1(0x03);
        return abi.encodePacked(sec1Prefix, bytes32(publicKey.x));
    }
}
