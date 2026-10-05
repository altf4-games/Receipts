// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {IPerplExchange} from "./interfaces/IPerplExchange.sol";
import {PerplOracleLib} from "./libraries/PerplOracleLib.sol";

/// @title PriceTape: an append-only tape of Perpl oracle samples, written by the Chainlink CRE workflow
/// @notice Trust model. The tape NEVER believes a price handed to it: every sample is read from the Perpl Exchange
///         inside the transaction (`PerplOracleLib.snapshot`) and appended only if its oracle timestamp is newer than
///         the last sample. A forged report can therefore at most trigger a true sample. `sample` is also callable by
///         anyone (the bots' keeper does it as a fallback), so the tape does not depend on CRE being up.
///         The CRE report adds one thing the chain cannot know: the price Perpl's REST API returned at the same
///         moment. That is stored as a `CrossCheck` event for transparency and is never used for scoring.
/// @dev    Path resolution is the tape density: only samples somebody paid for exist. Disclosed in the README.
contract PriceTape is ERC165, IReceiver {
    /// @dev one storage slot: 8 + 8 + 16 bytes
    struct Sample {
        uint64 ts; // oracle timestamp (Data Streams), seconds
        uint64 blockNumber; // block in which it was recorded
        uint128 price; // oraclePNS, in decimals[perpId] decimals
    }

    IPerplExchange public immutable exchange;
    uint32 public immutable maxOracleAge;
    /// @notice CRE forwarder allowed to call `onReport` (MockKeystoneForwarder in simulation, KeystoneForwarder in production).
    address public immutable forwarder;

    mapping(uint256 perpId => Sample[]) private _samples;
    mapping(uint256 perpId => uint8) public decimalsOf;

    event Sampled(uint256 indexed perpId, uint256 indexed index, uint64 oracleTs, uint128 price, address indexed writer);
    event CrossCheck(uint256 indexed perpId, uint128 oraclePrice, uint128 restPrice, uint256 divergenceBps);

    error NotForwarder(address caller);
    error BadReport();
    error PriceDecimalsChanged(uint256 perpId, uint8 had, uint8 now_);
    error ZeroAddress();

    constructor(IPerplExchange exchange_, uint32 maxOracleAge_, address forwarder_) {
        if (address(exchange_) == address(0) || forwarder_ == address(0)) revert ZeroAddress();
        exchange = exchange_;
        maxOracleAge = maxOracleAge_;
        forwarder = forwarder_;
    }

    // ------------------------------------------------------------------ writes
    /// @notice Record the current oracle price of each market if it is newer than the last sample. Permissionless.
    /// @return appended how many new samples were written
    function sample(uint256[] calldata perpIds) external returns (uint256 appended) {
        for (uint256 i = 0; i < perpIds.length; i++) {
            if (_record(perpIds[i])) appended++;
        }
    }

    /// @notice CRE entry point. `report` = abi.encode(uint256[] perpIds, uint128[] restPrices); restPrice 0 = REST unavailable.
    function onReport(bytes calldata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        (uint256[] memory perpIds, uint128[] memory restPrices) = abi.decode(report, (uint256[], uint128[]));
        if (perpIds.length != restPrices.length) revert BadReport();
        for (uint256 i = 0; i < perpIds.length; i++) {
            _record(perpIds[i]);
            Sample[] storage s = _samples[perpIds[i]];
            uint128 p = s[s.length - 1].price;
            uint256 div = restPrices[i] == 0 ? 0 : _divergenceBps(p, restPrices[i]);
            emit CrossCheck(perpIds[i], p, restPrices[i], div);
        }
    }

    function _record(uint256 perpId) internal returns (bool) {
        PerplOracleLib.Snapshot memory s = PerplOracleLib.snapshot(exchange, perpId, maxOracleAge);
        Sample[] storage arr = _samples[perpId];
        uint256 n = arr.length;
        if (n == 0) {
            decimalsOf[perpId] = s.priceDecimals;
        } else {
            if (decimalsOf[perpId] != s.priceDecimals) revert PriceDecimalsChanged(perpId, decimalsOf[perpId], s.priceDecimals);
            if (s.oracleTs <= arr[n - 1].ts) return false; // nothing new
        }
        arr.push(Sample({ts: s.oracleTs, blockNumber: uint64(block.number), price: s.price}));
        emit Sampled(perpId, n, s.oracleTs, s.price, msg.sender);
        return true;
    }

    function _divergenceBps(uint128 a, uint128 b) internal pure returns (uint256) {
        uint256 hi = a > b ? a : b;
        uint256 lo = a > b ? b : a;
        return ((hi - lo) * 10_000) / lo;
    }

    // ------------------------------------------------------------------ reads
    function sampleCount(uint256 perpId) external view returns (uint256) {
        return _samples[perpId].length;
    }

    function sampleAt(uint256 perpId, uint256 index) external view returns (Sample memory) {
        return _samples[perpId][index];
    }

    /// @notice Index of the first sample with ts >= `ts` (binary search), or sampleCount if none.
    function firstIndexAtOrAfter(uint256 perpId, uint64 ts) external view returns (uint256) {
        Sample[] storage arr = _samples[perpId];
        uint256 lo = 0;
        uint256 hi = arr.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (arr[mid].ts < ts) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
