// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Script, console } from "forge-std/Script.sol";

import { Revocation } from "../../src/revocation/Revocation.sol";

contract CreateRevocationRegistry is Script {
    function run() external returns (uint256 registryId) {
        Revocation revocation = Revocation(vm.envAddress("REVOCATION"));
        address revocationAdmin = vm.envAddress("REVOCATION_ADMIN");
        return createRevocationRegistry(revocation, revocationAdmin);
    }

    function createRevocationRegistry(Revocation revocation, address admin) public returns (uint256 registryId) {
        vm.broadcast();
        registryId = revocation.createRegistry(admin);

        console.log("revocation registry id", registryId);
        console.log("registry admin", admin);
    }
}
