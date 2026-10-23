// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { IdentityRegistryTestBase } from "../utils/IdentityRegistryTestBase.sol";

contract IdentityRegistryFuzzTest is IdentityRegistryTestBase {
    /// @dev Whoever submits it, the member proof is what authorises the write: no write path reads
    /// msg.sender, which is what makes stealth-address and paymaster submission possible.
    function testFuzz_RegisterIdentity_AcceptedFromAnySender(address sender) public {
        vm.assume(sender != address(0) && sender.code.length == 0);

        vm.prank(sender);
        identityRegistry.registerIdentity(networkIdA, metaA, _proof("registerA"));

        assertEq(identityRegistry.identity(networkIdA), metaA);
    }
}
