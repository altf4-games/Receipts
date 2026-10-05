// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Chainlink CRE report receiver interface (same shape as the CRE `IReceiver`): the forwarder calls `onReport`.
interface IReceiver {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}
