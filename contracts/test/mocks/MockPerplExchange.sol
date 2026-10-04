// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPerplExchange} from "../../src/interfaces/IPerplExchange.sol";

/// @dev UNIT-TEST ONLY. Never proof of anything. Every path it covers is also tested in test/fork against the
///      real Perpl Exchange. Reverts like the real one for unknown markets.
contract MockPerplExchange is IPerplExchange {
    error ContractDoesNotExist(uint256 perpId);

    mapping(uint256 => PerpetualInfo) private _info;
    mapping(uint256 => bool) private _exists;

    function setOracle(uint256 perpId, uint256 price, uint256 oracleTs, uint256 decimals) external {
        _exists[perpId] = true;
        PerpetualInfo storage i = _info[perpId];
        i.name = "MOCK Perp";
        i.symbol = "MOCK";
        i.priceDecimals = decimals;
        i.oraclePNS = price;
        i.oracleTimestampSec = oracleTs;
        i.refPriceMaxAgeSec = 60;
    }

    function setIgnOracle(uint256 perpId, bool v) external {
        _info[perpId].ignOracle = v;
    }

    function getPerpetualInfo(uint256 perpId) external view returns (PerpetualInfo memory) {
        if (!_exists[perpId]) revert ContractDoesNotExist(perpId);
        return _info[perpId];
    }
}
