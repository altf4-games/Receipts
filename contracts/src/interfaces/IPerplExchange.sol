// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Minimal view of the Perpl Exchange. Layout copied from the published ABI
///         (PerplFoundation/dex-sdk, crates/sdk/abi/dex/Exchange.json, contract v1.7.5).
///         Perpl's V2 getter appends `fundingSumScalingExp`; trailing fields are ignored on decode.
interface IPerplExchange {
    struct PerpetualInfo {
        string name;
        string symbol;
        uint256 priceDecimals;
        uint256 lotDecimals;
        bytes32 linkFeedId;
        uint256 priceTolPer100K;
        uint256 marginTol;
        uint256 marginTolDecimals;
        uint256 refPriceMaxAgeSec;
        uint256 positionBalanceCNS;
        uint256 insuranceBalanceCNS;
        uint256 markPNS;
        uint256 markTimestamp;
        uint256 lastPNS;
        uint256 lastTimestamp;
        uint256 oraclePNS;
        uint256 oracleTimestampSec;
        uint256 longOpenInterestLNS;
        uint256 shortOpenInterestLNS;
        uint256 fundingStartBlock;
        int16 fundingRatePct100k;
        uint256 absFundingClampPctPer100K;
        uint8 status;
        uint256 basePricePNS;
        uint256 maxBidPriceONS;
        uint256 minBidPriceONS;
        uint256 maxAskPriceONS;
        uint256 minAskPriceONS;
        uint256 numOrders;
        bool ignOracle;
    }

    /// @dev Reverts with `ContractDoesNotExist(perpId)` for an unknown market (observed live).
    function getPerpetualInfo(uint256 perpId) external view returns (PerpetualInfo memory);
}
