// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title IApprovedIssuerSet
/// @notice The one call the NetworkMemberRegistry makes into the approved-issuer set.
/// @dev Exists only to break the import cycle: the set reads the registry for authorization, and the
/// registry calls the set when it removes a member. Deliberately not the full ABI.
interface IApprovedIssuerSet {
    /// @notice Retires every signing key a member has published.
    /// @param memberNetworkId The member whose keys are being retired.
    function retireAllIssuerKeys(bytes32 memberNetworkId) external;

    /// @notice The registry this set answers, so the registry can refuse to wire a set built for
    /// another one.
    function memberRegistry() external view returns (address);
}
