// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Vm } from "forge-std/Test.sol";

import { IERC5564Announcer } from "../../src/interfaces/IERC5564Announcer.sol";
import { TestBase } from "../utils/TestBase.sol";

contract ERC5564AnnouncerForkTest is TestBase {
    address constant ERC5564_ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    uint256 internal constant ERC_5564_SCHEME_ID = 1;

    address internal stealthAddress = makeAddr("stealthAddress");
    bytes internal ephemeralPubKey;
    bytes internal metadata;

    IERC5564Announcer internal erc5564Announcer = IERC5564Announcer(ERC5564_ANNOUNCER);

    function setUp() public {
        Vm.Wallet memory ephemeral = vm.createWallet("ephemeral");
        ephemeralPubKey = _compressPublicKey(PubKey(ephemeral.publicKeyX, ephemeral.publicKeyY));

        bytes32 hashedSharedSecret = keccak256("mock shared secret");
        bytes1 viewTag = hashedSharedSecret[0];
        metadata = abi.encodePacked(viewTag);

        vm.createSelectFork("mainnet");
    }

    function test_Announce_EmitsAnnouncementInErc5564Form() public {
        vm.expectEmit(address(erc5564Announcer));
        emit IERC5564Announcer.Announcement(
            ERC_5564_SCHEME_ID, stealthAddress, address(this), ephemeralPubKey, metadata
        );

        erc5564Announcer.announce(ERC_5564_SCHEME_ID, stealthAddress, ephemeralPubKey, metadata);
    }

    function test_Announce_EmitsSenderAsCaller() public {
        address sender = makeAddr("networkMemberServer");

        vm.expectEmit(address(erc5564Announcer));
        emit IERC5564Announcer.Announcement(ERC_5564_SCHEME_ID, stealthAddress, sender, ephemeralPubKey, metadata);

        vm.prank(sender);
        erc5564Announcer.announce(ERC_5564_SCHEME_ID, stealthAddress, ephemeralPubKey, metadata);
    }
}
