// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import { Sha256IssuerRegistries } from "./Sha256IssuerRegistries.sol";
import { IssuerRegistryService } from "../base/IssuerRegistryService.sol";

/// @title Sha256IssuerRegistry
/// @notice Deployable issuer registry service over SHA-256 trees.
contract Sha256IssuerRegistry is IssuerRegistryService, Sha256IssuerRegistries { }
