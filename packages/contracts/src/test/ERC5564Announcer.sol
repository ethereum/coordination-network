// https://github.com/ScopeLift/stealth-address-erc-contracts/blob/main/src/ERC5564Announcer.sol
// SPDX-License-Identifier: CC0-1.0
pragma solidity ^0.8.34;

import { IERC5564Announcer } from "../interfaces/IERC5564Announcer.sol";

/// @notice `ERC5564Announcer` contract to emit an `Announcement` event to broadcast information
/// about a transaction involving a stealth address. See
/// [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) to learn more.
contract ERC5564Announcer is IERC5564Announcer {
    /// @inheritdoc IERC5564Announcer
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external
    {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}
