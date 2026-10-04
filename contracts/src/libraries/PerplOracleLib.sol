// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IPerplExchange} from "../interfaces/IPerplExchange.sol";

/// @notice Reads Perpl's Chainlink Data Streams price (`oraclePNS`) and refuses anything unsafe to score with.
library PerplOracleLib {
    /// @dev Oracle timestamps come from Data Streams, not this chain's clock. Allow a few seconds of skew.
    uint256 internal constant FUTURE_TOLERANCE = 5;

    struct Snapshot {
        uint128 price; // oraclePNS, in `priceDecimals` decimals
        uint64 oracleTs; // seconds, as reported by the oracle
        uint8 priceDecimals;
    }

    error OracleIgnored(uint256 perpId);
    error OracleZeroPrice(uint256 perpId);
    error OracleStale(uint256 perpId, uint256 age, uint256 maxAge);
    error OracleFromFuture(uint256 perpId, uint256 oracleTs, uint256 nowTs);
    error PriceOutOfRange(uint256 perpId);

    function snapshot(IPerplExchange exchange, uint256 perpId, uint256 maxAge)
        internal
        view
        returns (Snapshot memory s)
    {
        IPerplExchange.PerpetualInfo memory info = exchange.getPerpetualInfo(perpId);
        if (info.ignOracle) revert OracleIgnored(perpId);
        if (info.oraclePNS == 0) revert OracleZeroPrice(perpId);
        if (info.oraclePNS > type(uint128).max || info.oracleTimestampSec > type(uint64).max || info.priceDecimals > 36)
        {
            revert PriceOutOfRange(perpId);
        }

        uint256 ts = info.oracleTimestampSec;
        uint256 nowTs = block.timestamp;
        uint256 age;
        if (ts > nowTs) {
            if (ts - nowTs > FUTURE_TOLERANCE) revert OracleFromFuture(perpId, ts, nowTs);
            age = 0;
        } else {
            age = nowTs - ts;
        }
        if (age > maxAge) revert OracleStale(perpId, age, maxAge);

        s = Snapshot({price: uint128(info.oraclePNS), oracleTs: uint64(ts), priceDecimals: uint8(info.priceDecimals)});
    }
}
