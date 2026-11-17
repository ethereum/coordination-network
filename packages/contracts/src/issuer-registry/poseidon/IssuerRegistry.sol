// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { PoseidonIssuerRegistries } from "./PoseidonIssuerRegistries.sol";
import { IssuerRegistryService } from "../base/IssuerRegistryService.sol";

/// @title IssuerRegistry
/// @notice Deployable issuer registry service over Poseidon (BN254) trees.
contract IssuerRegistry is IssuerRegistryService, PoseidonIssuerRegistries { }
