// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { EntryPoint } from "@account-abstraction/contracts/core/EntryPoint.sol";
import { Test } from "forge-std/Test.sol";
import {
    CompatibilityFallbackHandler
} from "@safe-global/safe-smart-account/contracts/handler/CompatibilityFallbackHandler.sol";
import { Safe } from "@safe-global/safe-smart-account/contracts/Safe.sol";
import { SafeProxyFactory } from "@safe-global/safe-smart-account/contracts/proxies/SafeProxyFactory.sol";
import { Semaphore } from "@semaphore-protocol/contracts/Semaphore.sol";
import { SemaphoreVerifier } from "@semaphore-protocol/contracts/base/SemaphoreVerifier.sol";
import { ISemaphoreVerifier } from "@semaphore-protocol/contracts/interfaces/ISemaphoreVerifier.sol";

import { DeployedThirdPartyContracts } from "../../script/libraries/DeployedThirdPartyContracts.sol";

/// @dev Deploy third party contracts to local chain
abstract contract CanonicalDependencies is Test {
    constructor() {
        vm.etch(DeployedThirdPartyContracts.POSEIDON_T3, vm.getDeployedCode("PoseidonT3.sol:PoseidonT3"));
        vm.etch(DeployedThirdPartyContracts.POSEIDON_T4, vm.getDeployedCode("PoseidonT4.sol:PoseidonT4"));
        vm.etch(DeployedThirdPartyContracts.ENTRY_POINT, address(new EntryPoint()).code);
        vm.etch(DeployedThirdPartyContracts.SEMAPHORE_VERIFIER, address(new SemaphoreVerifier()).code);
        vm.etch(
            DeployedThirdPartyContracts.SEMAPHORE,
            address(new Semaphore(ISemaphoreVerifier(DeployedThirdPartyContracts.SEMAPHORE_VERIFIER))).code
        );
        vm.etch(DeployedThirdPartyContracts.SAFE_SINGLETON, address(new Safe()).code);
        vm.etch(DeployedThirdPartyContracts.SAFE_PROXY_FACTORY, address(new SafeProxyFactory()).code);
        vm.etch(
            DeployedThirdPartyContracts.SAFE_COMPATIBILITY_FALLBACK_HANDLER,
            address(new CompatibilityFallbackHandler()).code
        );
    }
}
