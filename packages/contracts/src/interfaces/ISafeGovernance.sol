// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @notice The Safe surface a governance module needs: reading the owner set, and making the Safe act
/// on the module's behalf.
/// @dev Declared here rather than imported so the production sources state exactly which Safe
/// functions they depend on. `operation` is Safe's `Enum.Operation`, which encodes as a uint8.
interface ISafeGovernance {
    /// @notice The Safe's current owners.
    function getOwners() external view returns (address[] memory);

    /// @notice Whether `owner` is one of the Safe's owners.
    function isOwner(address owner) external view returns (bool);

    /// @notice The number of signatures the Safe currently requires.
    function getThreshold() external view returns (uint256);

    /// @notice Executes a transaction as the Safe, callable only by an enabled module.
    /// @dev Returns `false` on an inner revert rather than bubbling it, so a caller must check.
    function execTransactionFromModuleReturnData(address to, uint256 value, bytes memory data, uint8 operation)
        external
        returns (bool success, bytes memory returnData);
}

/// @notice The Safe's owner-set functions. Only the Safe itself may call them, so a module reaches
/// them by having the Safe call itself.
interface ISafeOwnerManager {
    /// @notice Adds an owner and sets the threshold in one call.
    function addOwnerWithThreshold(address owner, uint256 threshold) external;

    /// @notice Removes an owner and sets the threshold in one call.
    /// @param prevOwner The owner preceding `owner` in the Safe's owner linked list.
    function removeOwner(address prevOwner, address owner, uint256 threshold) external;
}
