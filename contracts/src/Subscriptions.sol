// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface ICuratorBondedSubs {
    function isBonded(address curator) external view returns (bool);
}

/// @notice Per-second payment streams from a subscriber to a curator, in the bond token (AUSD).
///         One stream per (subscriber, curator). The subscriber deposits up front; value accrues to the curator
///         linearly at the curator's rate and the subscriber can cancel at any time for an exact refund of the
///         unaccrued part. No owner, no fees, no admin: the contract only moves value between the two parties.
///         All math is integer multiplication (rate x seconds), so there is no rounding: deposit == paid + refund.
///         Assumes a plain ERC-20 (no fee on transfer), which holds for Agora AUSD.
contract Subscriptions is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Stream {
        uint128 deposit; // total deposited into the current stream
        uint128 claimed; // part of the accrued amount already moved to the curator's balance
        uint128 rate; // token units per second, fixed when the stream starts
        uint64 start; // stream start timestamp
    }

    IERC20 public immutable token;
    ICuratorBondedSubs public immutable curators;

    uint128 public constant MAX_RATE = 1_000e6; // 1,000 AUSD per second; far above any sane price, bounds overflow

    mapping(address curator => uint128) public ratePerSec; // price for NEW streams (0 = not accepting)
    mapping(address curator => mapping(address subscriber => Stream)) private _streams;
    mapping(address curator => uint256) public owed; // accrued and settled, waiting for the curator to withdraw

    event RateSet(address indexed curator, uint128 ratePerSec);
    event Subscribed(
        address indexed subscriber,
        address indexed curator,
        address indexed payer,
        uint256 amount,
        uint128 rate,
        uint64 start,
        uint64 activeUntil
    );
    event Cancelled(address indexed subscriber, address indexed curator, uint256 refunded, uint256 paidToCurator);
    event Claimed(address indexed curator, uint256 amount);

    error ZeroAddress();
    error NotBondedCurator();
    error NotAccepting();
    error RateTooHigh();
    error AmountTooSmall(uint256 amount, uint256 minAmount);
    error NoStream();

    constructor(IERC20 token_, ICuratorBondedSubs curators_) {
        if (address(token_) == address(0) || address(curators_) == address(0)) revert ZeroAddress();
        token = token_;
        curators = curators_;
    }

    // ------------------------------------------------------------------ curator side
    /// @notice Set the price for new streams. 0 stops accepting new subscribers. Running streams keep their rate.
    function setRate(uint128 newRate) external {
        if (!curators.isBonded(msg.sender)) revert NotBondedCurator();
        if (newRate > MAX_RATE) revert RateTooHigh();
        ratePerSec[msg.sender] = newRate;
        emit RateSet(msg.sender, newRate);
    }

    /// @notice Move everything accrued on the listed streams into the caller's balance, then pay out the full balance.
    ///         An empty list only withdraws what earlier settlements left in the balance.
    function claim(address[] calldata subscribers) external nonReentrant returns (uint256 paid) {
        for (uint256 i = 0; i < subscribers.length; i++) {
            Stream storage s = _streams[msg.sender][subscribers[i]];
            _settle(msg.sender, s);
        }
        paid = owed[msg.sender];
        if (paid == 0) return 0;
        owed[msg.sender] = 0;
        token.safeTransfer(msg.sender, paid);
        emit Claimed(msg.sender, paid);
    }

    // ------------------------------------------------------------------ subscriber side
    function subscribe(address curator, uint256 amount) external nonReentrant {
        _subscribe(msg.sender, curator, msg.sender, amount);
    }

    /// @notice Pay for someone else's subscription (used by cross-chain deposit-and-execute flows).
    ///         The beneficiary owns the stream: only they can cancel, and any refund goes to them.
    function subscribeFor(address beneficiary, address curator, uint256 amount) external nonReentrant {
        if (beneficiary == address(0)) revert ZeroAddress();
        _subscribe(beneficiary, curator, msg.sender, amount);
    }

    /// @notice End the stream now. The curator keeps what accrued up to this second, the caller gets the rest.
    function cancel(address curator) external nonReentrant returns (uint256 refund) {
        Stream storage s = _streams[curator][msg.sender];
        if (s.deposit == 0) revert NoStream();
        uint256 total = s.deposit;
        uint256 earned = _accrued(s);
        _settle(curator, s);
        refund = total - earned;
        delete _streams[curator][msg.sender];
        if (refund > 0) token.safeTransfer(msg.sender, refund);
        emit Cancelled(msg.sender, curator, refund, earned);
    }

    // ------------------------------------------------------------------ views
    function getStream(address curator, address subscriber) external view returns (Stream memory) {
        return _streams[curator][subscriber];
    }

    /// @notice True while the stream still has unaccrued deposit. This is what the delivery server checks.
    function isActive(address subscriber, address curator) public view returns (bool) {
        Stream storage s = _streams[curator][subscriber];
        return s.deposit != 0 && _accrued(s) < s.deposit;
    }

    /// @notice First second at which the stream is no longer active (0 if there is no stream).
    function activeUntil(address subscriber, address curator) public view returns (uint64) {
        Stream storage s = _streams[curator][subscriber];
        return _activeUntil(s);
    }

    /// @notice Amount accrued to the curator so far on this stream (including what was already claimed).
    function accrued(address subscriber, address curator) external view returns (uint256) {
        return _accrued(_streams[curator][subscriber]);
    }

    /// @notice What `cancel` would refund right now.
    function refundable(address subscriber, address curator) external view returns (uint256) {
        Stream storage s = _streams[curator][subscriber];
        return s.deposit - _accrued(s);
    }

    /// @notice What the curator could withdraw right now by claiming exactly these streams.
    function claimable(address curator, address[] calldata subscribers) external view returns (uint256 total) {
        total = owed[curator];
        for (uint256 i = 0; i < subscribers.length; i++) {
            Stream storage s = _streams[curator][subscribers[i]];
            total += _accrued(s) - s.claimed;
        }
    }

    // ------------------------------------------------------------------ internals
    function _subscribe(address subscriber, address curator, address payer, uint256 amount) internal {
        if (!curators.isBonded(curator)) revert NotBondedCurator();
        Stream storage s = _streams[curator][subscriber];

        uint128 rate;
        if (s.deposit != 0 && _accrued(s) < s.deposit) {
            // still running: top up, keep the original rate and start
            rate = s.rate;
        } else {
            rate = ratePerSec[curator];
            if (rate == 0) revert NotAccepting();
        }
        if (amount < rate) revert AmountTooSmall(amount, rate); // at least one second
        if (amount > type(uint128).max - s.deposit) revert AmountTooSmall(amount, 0); // uint128 overflow guard

        token.safeTransferFrom(payer, address(this), amount);

        if (s.deposit != 0 && _accrued(s) < s.deposit) {
            s.deposit += uint128(amount);
        } else {
            // new or fully-consumed stream: bank what the old one earned, then start fresh
            _settle(curator, s);
            s.deposit = uint128(amount);
            s.claimed = 0;
            s.rate = rate;
            s.start = uint64(block.timestamp);
        }
        emit Subscribed(subscriber, curator, payer, amount, s.rate, s.start, _activeUntil(s));
    }

    /// @dev moves accrued-but-unsettled value of one stream into the curator's pull balance.
    function _settle(address curator, Stream storage s) internal {
        uint256 a = _accrued(s);
        uint256 delta = a - s.claimed;
        if (delta != 0) {
            s.claimed = uint128(a);
            owed[curator] += delta;
        }
    }

    function _accrued(Stream storage s) internal view returns (uint256) {
        if (s.deposit == 0) return 0;
        uint256 elapsed = block.timestamp - s.start;
        uint256 a = uint256(s.rate) * elapsed;
        return a < s.deposit ? a : s.deposit;
    }

    function _activeUntil(Stream storage s) internal view returns (uint64) {
        if (s.deposit == 0) return 0;
        uint256 secs = (uint256(s.deposit) + s.rate - 1) / s.rate; // ceil: first second with accrued == deposit
        return uint64(s.start + secs);
    }
}
