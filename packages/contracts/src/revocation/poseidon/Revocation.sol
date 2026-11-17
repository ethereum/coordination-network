// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { PoseidonRevocationRegistries } from "./PoseidonRevocationRegistries.sol";
import { RevocationService } from "../base/RevocationService.sol";

/// @title Revocation
/// @notice Deployable revocation service over Poseidon (BN254) trees.
contract Revocation is RevocationService, PoseidonRevocationRegistries { }
