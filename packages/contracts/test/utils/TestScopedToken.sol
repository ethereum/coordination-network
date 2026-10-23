// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { ERC1155 } from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";

/// @notice Mock network member scoped token, so the indexer's balance reads
// can be tested against a chain. Anyone may mint.
contract TestScopedToken is ERC1155 {
    constructor() ERC1155("") { }

    /// @notice Mints token to stealth account. Permissionless for testing.
    /// @param account The stealth account receiving the tokens.
    /// @param id The token id.
    /// @param amount How many tokens to credit.
    function mint(address account, uint256 id, uint256 amount) external {
        _mint(account, id, amount, "");
    }
}
