// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Sha256RevocationRegistries } from "./Sha256RevocationRegistries.sol";
import { RevocationService } from "../base/RevocationService.sol";

/// @title Sha256Revocation
/// @notice Deployable revocation service over SHA-256 trees.
contract Sha256Revocation is RevocationService, Sha256RevocationRegistries { }
