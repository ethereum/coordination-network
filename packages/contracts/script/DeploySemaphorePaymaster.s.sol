// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { console } from "forge-std/Script.sol";

import { SemaphorePaymaster } from "../src/SemaphorePaymaster.sol";
import { DeployBase } from "./base/DeployBase.sol";
import { DeployedThirdPartyContracts } from "./libraries/DeployedThirdPartyContracts.sol";

contract DeploySemaphorePaymaster is DeployBase {
    bytes32 public constant SALT = keccak256("coordination-network.SemaphorePaymaster.V1.1");

    function run() external returns (SemaphorePaymaster paymaster) {
        address owner = vm.envAddress("OWNER");
        uint256 maxCostPerOp = vm.envUint("MAX_COST_PER_OP");
        return deploySemaphorePaymaster(owner, maxCostPerOp);
    }

    function deploySemaphorePaymaster(address owner, uint256 maxCostPerOp)
        public
        returns (SemaphorePaymaster paymaster)
    {
        bytes memory initCode = abi.encodePacked(
            type(SemaphorePaymaster).creationCode,
            abi.encode(
                DeployedThirdPartyContracts.ENTRY_POINT,
                DeployedThirdPartyContracts.SEMAPHORE_VERIFIER,
                owner,
                maxCostPerOp
            )
        );
        address existingAddress = alreadyDeployedAt(SALT, initCode);
        if (existingAddress != address(0)) return SemaphorePaymaster(payable(existingAddress));

        vm.startBroadcast();
        uint256 gasBeforeDeployment = gasleft();
        paymaster = new SemaphorePaymaster{ salt: SALT }(
            DeployedThirdPartyContracts.ENTRY_POINT, DeployedThirdPartyContracts.SEMAPHORE_VERIFIER, owner, maxCostPerOp
        );
        deploymentGas = gasBeforeDeployment - gasleft();
        vm.stopBroadcast();

        console.log("SemaphorePaymaster", address(paymaster));
    }
}
