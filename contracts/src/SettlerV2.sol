// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {CallRegistry} from "./CallRegistry.sol";
import {IReceiver} from "./interfaces/IReceiver.sol";
import {PriceTape} from "./PriceTape.sol";

/// @title SettlerV2: path-aware, disputable settlement from the CRE price tape
/// @notice Scores a revealed call by the FIRST tape sample that touches its take-profit or stop-loss inside
///         (entryOracleTs, horizonEnd), or by the first tape sample at or after the horizon when nothing touched.
///         Nothing here believes a claim: `propose` checks the claimed sample against the tape, anyone can
///         `dispute` with an earlier touching sample during the window, and `finalize` closes the call in the
///         registry. Every step is O(1) gas.
/// @dev    Fixes SettlerV1's two disclosed weaknesses: the caller no longer picks the exit price, and touches
///         between entry and horizon are visible. Remaining limit: path resolution = tape density.
contract SettlerV2 is ERC165, IReceiver {
    uint16 public constant FLAG_LATE = 2; // endpoint sample was more than LATE_AFTER_SECS after the horizon
    uint16 public constant FLAG_PATH_TAPE = 4; // scored from the price tape (path aware)
    uint16 public constant FLAG_DISPUTED = 8; // a proposal was overturned by a dispute
    uint64 public constant LATE_AFTER_SECS = 180;
    int256 private constant BPS = 10_000;

    CallRegistry public immutable registry;
    PriceTape public immutable tape;
    uint32 public immutable disputeWindow;
    /// @notice CRE forwarder allowed to call `onReport` (batch proposals).
    address public immutable forwarder;

    struct Proposal {
        uint64 proposedAt; // 0 = none
        uint32 index; // tape index of the deciding sample
        int32 scoreBps;
        bool touch; // true: TP/SL touched; false: endpoint
        bool disputed;
        bool finalized;
    }

    mapping(uint256 callId => Proposal) public proposals;

    event Proposed(uint256 indexed callId, uint32 index, bool touch, int32 scoreBps, address indexed by);
    event Disputed(uint256 indexed callId, uint32 oldIndex, uint32 newIndex, int32 scoreBps, address indexed by);
    event Finalized(uint256 indexed callId, int32 scoreBps, uint16 flags);
    event ProposalRejected(uint256 indexed callId, bytes reason);

    error NotRevealed(uint256 callId);
    error TooEarly(uint64 horizonEnd);
    error AlreadyProposed(uint256 callId);
    error NoProposal(uint256 callId);
    error WindowOpen(uint64 until);
    error WindowClosed(uint64 closedAt);
    error AlreadyFinalized(uint256 callId);
    error NoSuchSample(uint256 index, uint256 count);
    error DecimalsMismatch(uint8 call_, uint8 tape_);
    error NotATouch(uint256 index);
    error SampleOutsidePath(uint64 ts, uint64 entryTs, uint64 horizonEnd);
    error NotFirstAfterHorizon(uint256 index);
    error NotEarlier(uint32 proposed, uint32 disputed);
    error NotForwarder(address caller);
    error BadReport();
    error ZeroAddress();

    constructor(CallRegistry registry_, PriceTape tape_, uint32 disputeWindow_, address forwarder_) {
        if (address(registry_) == address(0) || address(tape_) == address(0) || forwarder_ == address(0)) revert ZeroAddress();
        registry = registry_;
        tape = tape_;
        disputeWindow = disputeWindow_;
        forwarder = forwarder_;
    }

    // ------------------------------------------------------------------ propose / dispute / finalize
    /// @notice Propose the deciding tape sample for a call. Anyone may call (the CRE workflow does it through `onReport`).
    ///         If the sample is inside the path it must touch TP or SL; if it is at/after the horizon it must be the
    ///         FIRST sample at/after the horizon and the call is scored at its price (clamped into [-sl, +tp]).
    function propose(uint256 callId, uint32 index) public {
        CallRegistry.Call memory c = registry.getCall(callId);
        if (c.status != CallRegistry.Status.Revealed) revert NotRevealed(callId);
        if (block.timestamp < c.horizonEnd) revert TooEarly(c.horizonEnd);
        if (proposals[callId].proposedAt != 0) revert AlreadyProposed(callId);

        PriceTape.Sample memory s = _sample(c, index);
        int32 score;
        bool touch;
        if (s.ts < c.horizonEnd) {
            (touch, score) = _touchScore(c, s);
            if (!touch) revert NotATouch(index);
        } else {
            // endpoint: must be the first sample at or after the horizon, so the proposer cannot pick a convenient one
            if (index != 0) {
                PriceTape.Sample memory prev = tape.sampleAt(c.perpId, index - 1);
                if (prev.ts >= c.horizonEnd) revert NotFirstAfterHorizon(index);
            }
            score = _clampedReturn(c, s.price);
        }
        proposals[callId] = Proposal({
            proposedAt: uint64(block.timestamp), index: index, scoreBps: score, touch: touch, disputed: false, finalized: false
        });
        emit Proposed(callId, index, touch, score, msg.sender);
    }

    /// @notice Overturn a proposal with an EARLIER sample that touches TP or SL. Anyone, during the window.
    function dispute(uint256 callId, uint32 earlierIndex) external {
        Proposal storage p = proposals[callId];
        if (p.proposedAt == 0) revert NoProposal(callId);
        if (p.finalized) revert AlreadyFinalized(callId);
        uint64 closesAt = p.proposedAt + disputeWindow;
        if (block.timestamp >= closesAt) revert WindowClosed(closesAt);

        CallRegistry.Call memory c = registry.getCall(callId);
        PriceTape.Sample memory s = _sample(c, earlierIndex);
        if (s.ts >= c.horizonEnd) revert SampleOutsidePath(s.ts, c.entryOracleTs, c.horizonEnd);
        (bool touch, int32 score) = _touchScore(c, s);
        if (!touch) revert NotATouch(earlierIndex);
        // a touch beats an endpoint proposal; between two touches the earlier sample wins
        if (p.touch && earlierIndex >= p.index) revert NotEarlier(p.index, earlierIndex);

        uint32 old = p.index;
        p.index = earlierIndex;
        p.scoreBps = score;
        p.touch = true;
        p.disputed = true;
        emit Disputed(callId, old, earlierIndex, score, msg.sender);
    }

    /// @notice After the dispute window, close the call in the registry with the surviving proposal. Anyone.
    function finalize(uint256 callId) external {
        Proposal storage p = proposals[callId];
        if (p.proposedAt == 0) revert NoProposal(callId);
        if (p.finalized) revert AlreadyFinalized(callId);
        uint64 closesAt = p.proposedAt + disputeWindow;
        if (block.timestamp < closesAt) revert WindowOpen(closesAt);
        p.finalized = true;

        uint16 flags = FLAG_PATH_TAPE;
        if (p.disputed) flags |= FLAG_DISPUTED;
        if (!p.touch) {
            CallRegistry.Call memory c = registry.getCall(callId);
            PriceTape.Sample memory s = tape.sampleAt(c.perpId, p.index);
            if (s.ts - c.horizonEnd > LATE_AFTER_SECS) flags |= FLAG_LATE;
        }
        registry.close(callId, p.scoreBps, flags);
        emit Finalized(callId, p.scoreBps, flags);
    }

    /// @notice CRE entry point: `report` = abi.encode(uint256[] callIds, uint32[] indexes). A bad item is skipped, not fatal.
    function onReport(bytes calldata, bytes calldata report) external override {
        if (msg.sender != forwarder) revert NotForwarder(msg.sender);
        (uint256[] memory ids, uint32[] memory idx) = abi.decode(report, (uint256[], uint32[]));
        if (ids.length != idx.length) revert BadReport();
        for (uint256 i = 0; i < ids.length; i++) {
            try this.propose(ids[i], idx[i]) {} catch (bytes memory reason) {
                emit ProposalRejected(ids[i], reason);
            }
        }
    }

    // ------------------------------------------------------------------ views
    /// @notice Pure helper for off-chain callers: would this sample touch the call's TP/SL, and at what score?
    function evaluate(uint256 callId, uint32 index) external view returns (bool touch, int32 score, uint64 ts) {
        CallRegistry.Call memory c = registry.getCall(callId);
        PriceTape.Sample memory s = _sample(c, index);
        (touch, score) = _touchScore(c, s);
        ts = s.ts;
    }

    // ------------------------------------------------------------------ internals
    function _sample(CallRegistry.Call memory c, uint32 index) internal view returns (PriceTape.Sample memory s) {
        uint256 n = tape.sampleCount(c.perpId);
        if (index >= n) revert NoSuchSample(index, n);
        uint8 d = tape.decimalsOf(c.perpId);
        if (d != c.priceDecimals) revert DecimalsMismatch(c.priceDecimals, d);
        s = tape.sampleAt(c.perpId, index);
        // path samples must be strictly after the entry snapshot; endpoint samples are checked by the caller
        if (s.ts <= c.entryOracleTs) revert SampleOutsidePath(s.ts, c.entryOracleTs, c.horizonEnd);
    }

    function _returnBps(CallRegistry.Call memory c, uint128 price) internal view returns (int256 raw) {
        raw = (int256(uint256(price)) - int256(uint256(c.entryPNS))) * BPS / int256(uint256(c.entryPNS));
        if (c.direction == registry.SHORT()) raw = -raw;
    }

    function _clampedReturn(CallRegistry.Call memory c, uint128 price) internal view returns (int32) {
        int256 raw = _returnBps(c, price);
        int256 lo = -int256(uint256(c.slBps));
        int256 hi = int256(uint256(c.tpBps));
        return int32(raw < lo ? lo : (raw > hi ? hi : raw));
    }

    function _touchScore(CallRegistry.Call memory c, PriceTape.Sample memory s) internal view returns (bool touch, int32 score) {
        int256 raw = _returnBps(c, s.price);
        if (raw >= int256(uint256(c.tpBps))) return (true, int32(uint32(c.tpBps)));
        if (raw <= -int256(uint256(c.slBps))) return (true, -int32(uint32(c.slBps)));
        return (false, 0);
    }

    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
