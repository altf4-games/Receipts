// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPerplExchange} from "./interfaces/IPerplExchange.sol";
import {PerplOracleLib} from "./libraries/PerplOracleLib.sol";

interface ICuratorBonded {
    function isBonded(address curator) external view returns (bool);
}

/// @title CallRegistry: the FACTS layer
/// @notice Stores only immutable facts about a call: the sealed hash, the oracle price snapshotted inside the
///         commit transaction, the reveal, and a final score written by the current settler within the call's
///         own declared bounds. Scoring logic lives in replaceable settler contracts. Never redeploy this
///         contract once real history exists.
///
/// Hash (what a curator commits, and what `reveal` recomputes):
///   keccak256(abi.encode(block.chainid, address(registry), curator, perpId,
///                        direction, tpBps, slBps, horizonSecs, salt))
///   types: uint256, address, address, uint256, uint8, uint16, uint16, uint32, bytes32
///   direction: 1 = long, 2 = short.
///
/// Owner powers (all of them, nothing else): add/remove markets for NEW commits, tune `maxOracleAge` inside
/// [MIN_ORACLE_AGE, MAX_ORACLE_AGE_CEILING], and rotate the settler (every rotation emits an event).
contract CallRegistry is Ownable {
    enum Status {
        None,
        Sealed,
        Revealed,
        Settled,
        Expired,
        Invalid
    }

    uint8 public constant LONG = 1;
    uint8 public constant SHORT = 2;
    uint16 public constant TP_CAP_BPS = 3000;
    uint16 public constant SL_CAP_BPS = 1500;
    /// @dev Equal to -TP_CAP: never revealing can never beat revealing a loss (worst revealed loss is -SL_CAP),
    ///      and a hedged pair (one winner at most +TP_CAP, one unrevealed at -TP_CAP) cannot have positive total.
    int32 public constant UNREVEALED_PENALTY_BPS = -3000;
    uint32 public constant MAX_HORIZON = 7 days;
    uint32 public constant MIN_ORACLE_AGE = 30;
    uint32 public constant MAX_ORACLE_AGE_CEILING = 600;

    struct Call {
        address curator;
        uint32 perpId;
        Status status;
        uint8 priceDecimals;
        uint8 direction; // set at reveal
        uint16 tpBps; // set at reveal
        uint16 slBps; // set at reveal
        uint16 flags; // set at close
        int32 scoreBps; // set at close / expire / invalid
        uint32 horizonSecs;
        uint64 commitBlock;
        uint64 commitTime;
        uint64 horizonEnd;
        uint64 entryOracleTs;
        uint64 revealBlock;
        uint64 closeBlock;
        uint128 entryPNS;
        bytes32 hash;
    }

    ICuratorBonded public immutable curators;
    IPerplExchange public immutable exchange;
    uint32 public immutable minHorizon;

    uint32 public maxOracleAge;
    address public settler;
    uint256 public nextCallId = 1;

    mapping(uint256 => Call) private _calls;
    mapping(address => mapping(uint256 => uint256)) public openCallId; // curator => perpId => callId (0 = none)
    mapping(address => uint256) public openCallCount;
    mapping(uint256 => bool) public marketAllowed;

    event Committed(
        uint256 indexed callId,
        address indexed curator,
        uint256 indexed perpId,
        bytes32 hash,
        uint32 horizonSecs,
        uint64 commitBlock,
        uint64 commitTime,
        uint64 horizonEnd,
        uint128 entryPNS,
        uint64 entryOracleTs,
        uint8 priceDecimals
    );
    event Revealed(uint256 indexed callId, uint8 direction, uint16 tpBps, uint16 slBps, bool valid);
    event Expired(uint256 indexed callId);
    event Closed(uint256 indexed callId, int32 scoreBps, uint16 flags, address settler);
    event SettlerChanged(address indexed oldSettler, address indexed newSettler);
    event MarketAllowedSet(uint256 indexed perpId, bool allowed);
    event MaxOracleAgeSet(uint32 maxOracleAge);

    error NotBonded(address curator);
    error MarketNotAllowed(uint256 perpId);
    error HorizonOutOfRange(uint32 horizonSecs, uint32 min, uint32 max);
    error OpenCallExists(uint256 perpId, uint256 callId);
    error ZeroHash();
    error UnknownCall(uint256 callId);
    error WrongStatus(uint256 callId, Status status);
    error RevealWindowClosed(uint64 horizonEnd);
    error BadReveal();
    error NotYetExpired(uint64 horizonEnd);
    error NotSettler();
    error ScoreOutOfBounds(int32 scoreBps, int32 lo, int32 hi);
    error OracleAgeOutOfRange();
    error ZeroAddress();

    constructor(
        address owner_,
        ICuratorBonded curators_,
        IPerplExchange exchange_,
        address settler_,
        uint32 minHorizon_,
        uint32 maxOracleAge_
    ) Ownable(owner_) {
        if (address(curators_) == address(0) || address(exchange_) == address(0)) revert ZeroAddress();
        curators = curators_;
        exchange = exchange_;
        minHorizon = minHorizon_;
        settler = settler_;
        _setMaxOracleAge(maxOracleAge_);
        emit SettlerChanged(address(0), settler_);
    }

    // ------------------------------------------------------------ curator actions

    /// @notice Seal a call. The oracle price and time are read from Perpl inside this transaction.
    function commit(uint256 perpId, bytes32 hash, uint32 horizonSecs) external returns (uint256 callId) {
        if (!curators.isBonded(msg.sender)) revert NotBonded(msg.sender);
        if (!marketAllowed[perpId]) revert MarketNotAllowed(perpId);
        if (horizonSecs < minHorizon || horizonSecs > MAX_HORIZON) {
            revert HorizonOutOfRange(horizonSecs, minHorizon, MAX_HORIZON);
        }
        uint256 existing = openCallId[msg.sender][perpId];
        if (existing != 0) revert OpenCallExists(perpId, existing);
        if (hash == bytes32(0)) revert ZeroHash();

        PerplOracleLib.Snapshot memory snap = PerplOracleLib.snapshot(exchange, perpId, maxOracleAge);

        callId = nextCallId++;
        uint64 nowTs = uint64(block.timestamp);
        Call storage c = _calls[callId];
        c.curator = msg.sender;
        c.perpId = uint32(perpId);
        c.status = Status.Sealed;
        c.priceDecimals = snap.priceDecimals;
        c.horizonSecs = horizonSecs;
        c.commitBlock = uint64(block.number);
        c.commitTime = nowTs;
        c.horizonEnd = nowTs + horizonSecs;
        c.entryOracleTs = snap.oracleTs;
        c.entryPNS = snap.price;
        c.hash = hash;

        openCallId[msg.sender][perpId] = callId;
        openCallCount[msg.sender] += 1;

        emit Committed(
            callId,
            msg.sender,
            perpId,
            hash,
            horizonSecs,
            c.commitBlock,
            nowTs,
            c.horizonEnd,
            snap.price,
            snap.oracleTs,
            snap.priceDecimals
        );
    }

    /// @notice Open the call. Callable by anyone (the delivery service reveals for the curator), up to and
    ///         including `horizonEnd`. If the hash matches but a parameter is out of bounds, the call becomes
    ///         `Invalid` and scores the penalty.
    function reveal(uint256 callId, uint8 direction, uint16 tpBps, uint16 slBps, bytes32 salt) external {
        Call storage c = _requireCall(callId);
        if (c.status != Status.Sealed) revert WrongStatus(callId, c.status);
        if (block.timestamp > c.horizonEnd) revert RevealWindowClosed(c.horizonEnd);
        if (hashCall(c.curator, c.perpId, direction, tpBps, slBps, c.horizonSecs, salt) != c.hash) revert BadReveal();

        bool valid = (direction == LONG || direction == SHORT) && tpBps > 0 && tpBps <= TP_CAP_BPS && slBps > 0
            && slBps <= SL_CAP_BPS;
        c.revealBlock = uint64(block.number);
        if (valid) {
            c.status = Status.Revealed;
            c.direction = direction;
            c.tpBps = tpBps;
            c.slBps = slBps;
        } else {
            c.status = Status.Invalid;
            c.scoreBps = UNREVEALED_PENALTY_BPS;
            c.closeBlock = uint64(block.number);
            _freeSlot(c);
        }
        emit Revealed(callId, direction, tpBps, slBps, valid);
    }

    /// @notice Anyone, strictly after `horizonEnd`, for a call that was never revealed. Scores the penalty.
    function expire(uint256 callId) external {
        Call storage c = _requireCall(callId);
        if (c.status != Status.Sealed) revert WrongStatus(callId, c.status);
        if (block.timestamp <= c.horizonEnd) revert NotYetExpired(c.horizonEnd);
        c.status = Status.Expired;
        c.scoreBps = UNREVEALED_PENALTY_BPS;
        c.closeBlock = uint64(block.number);
        _freeSlot(c);
        emit Expired(callId);
    }

    // ------------------------------------------------------------ settler

    /// @notice Only the current settler. The score must lie inside the call's own declared [-sl, +tp] bounds,
    ///         so even a faulty settler cannot book more than the curator committed to.
    function close(uint256 callId, int32 scoreBps, uint16 flags) external {
        if (msg.sender != settler) revert NotSettler();
        Call storage c = _requireCall(callId);
        if (c.status != Status.Revealed) revert WrongStatus(callId, c.status);
        int32 lo = -int32(uint32(c.slBps));
        int32 hi = int32(uint32(c.tpBps));
        if (scoreBps < lo || scoreBps > hi) revert ScoreOutOfBounds(scoreBps, lo, hi);
        c.status = Status.Settled;
        c.scoreBps = scoreBps;
        c.flags = flags;
        c.closeBlock = uint64(block.number);
        _freeSlot(c);
        emit Closed(callId, scoreBps, flags, msg.sender);
    }

    // ------------------------------------------------------------ owner

    function setSettler(address newSettler) external onlyOwner {
        if (newSettler == address(0)) revert ZeroAddress();
        emit SettlerChanged(settler, newSettler);
        settler = newSettler;
    }

    function setMarketAllowed(uint256 perpId, bool allowed) external onlyOwner {
        marketAllowed[perpId] = allowed;
        emit MarketAllowedSet(perpId, allowed);
    }

    function setMaxOracleAge(uint32 newMax) external onlyOwner {
        _setMaxOracleAge(newMax);
    }

    // ------------------------------------------------------------ views

    function getCall(uint256 callId) external view returns (Call memory) {
        return _calls[callId];
    }

    function hashCall(
        address curator,
        uint256 perpId,
        uint8 direction,
        uint16 tpBps,
        uint16 slBps,
        uint32 horizonSecs,
        bytes32 salt
    ) public view returns (bytes32) {
        return keccak256(
            abi.encode(block.chainid, address(this), curator, perpId, direction, tpBps, slBps, horizonSecs, salt)
        );
    }

    // ------------------------------------------------------------ internals

    function _requireCall(uint256 callId) internal view returns (Call storage c) {
        c = _calls[callId];
        if (c.status == Status.None) revert UnknownCall(callId);
    }

    function _freeSlot(Call storage c) internal {
        delete openCallId[c.curator][c.perpId];
        openCallCount[c.curator] -= 1;
    }

    function _setMaxOracleAge(uint32 v) internal {
        if (v < MIN_ORACLE_AGE || v > MAX_ORACLE_AGE_CEILING) revert OracleAgeOutOfRange();
        maxOracleAge = v;
        emit MaxOracleAgeSet(v);
    }
}
