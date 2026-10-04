// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {CallRegistry} from "./CallRegistry.sol";
import {IPerplExchange} from "./interfaces/IPerplExchange.sol";
import {PerplOracleLib} from "./libraries/PerplOracleLib.sol";

/// @title SettlerV1: endpoint scoring (APPROXIMATE, replaceable)
/// @notice Anyone may settle a revealed call after its horizon. The exit price is the oracle sample read at
///         settle time, required to be stamped at or after `horizonEnd`. Return in bps of entry, signed by
///         direction, clamped into the call's own [-sl, +tp].
///
/// Known weaknesses, disclosed (fixed by SettlerV2 with the CRE price tape):
///  1. The caller chooses WHICH post-horizon oracle sample is used. Late settles are flagged FLAG_LATE.
///  2. Price touches of TP/SL between entry and horizon are invisible; only the endpoint is scored.
///  Every score from this contract carries FLAG_APPROX_ENDPOINT.
contract SettlerV1 {
    uint16 public constant FLAG_APPROX_ENDPOINT = 1;
    uint16 public constant FLAG_LATE = 2;
    uint64 public constant LATE_AFTER_SECS = 180;
    int256 private constant BPS = 10_000;

    CallRegistry public immutable registry;
    IPerplExchange public immutable exchange;
    uint32 public immutable maxOracleAge;

    event Settled(
        uint256 indexed callId,
        uint128 entryPNS,
        uint128 exitPNS,
        uint64 exitOracleTs,
        int256 rawBps,
        int32 scoreBps,
        uint16 flags
    );

    error NotRevealed(uint256 callId);
    error TooEarly(uint64 horizonEnd);
    error OracleBeforeHorizon(uint64 oracleTs, uint64 horizonEnd);
    error PriceDecimalsChanged(uint8 atCommit, uint8 now_);

    constructor(CallRegistry registry_, IPerplExchange exchange_, uint32 maxOracleAge_) {
        registry = registry_;
        exchange = exchange_;
        maxOracleAge = maxOracleAge_;
    }

    function settle(uint256 callId) external returns (int32 scoreBps) {
        CallRegistry.Call memory c = registry.getCall(callId);
        if (c.status != CallRegistry.Status.Revealed) revert NotRevealed(callId);
        if (block.timestamp < c.horizonEnd) revert TooEarly(c.horizonEnd);

        PerplOracleLib.Snapshot memory exitSnap = PerplOracleLib.snapshot(exchange, c.perpId, maxOracleAge);
        if (exitSnap.oracleTs < c.horizonEnd) revert OracleBeforeHorizon(exitSnap.oracleTs, c.horizonEnd);
        if (exitSnap.priceDecimals != c.priceDecimals) revert PriceDecimalsChanged(c.priceDecimals, exitSnap.priceDecimals);

        int256 raw = (int256(uint256(exitSnap.price)) - int256(uint256(c.entryPNS))) * BPS / int256(uint256(c.entryPNS));
        if (c.direction == registry.SHORT()) raw = -raw;

        int256 lo = -int256(uint256(c.slBps));
        int256 hi = int256(uint256(c.tpBps));
        int256 clamped = raw < lo ? lo : (raw > hi ? hi : raw);
        scoreBps = int32(clamped);

        uint16 flags = FLAG_APPROX_ENDPOINT;
        if (exitSnap.oracleTs - c.horizonEnd > LATE_AFTER_SECS) flags |= FLAG_LATE;

        registry.close(callId, scoreBps, flags);
        emit Settled(callId, c.entryPNS, exitSnap.price, exitSnap.oracleTs, raw, scoreBps, flags);
    }
}
