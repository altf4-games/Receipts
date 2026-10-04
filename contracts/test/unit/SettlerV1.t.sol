// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "../Base.t.sol";
import {CallRegistry} from "../../src/CallRegistry.sol";
import {SettlerV1} from "../../src/SettlerV1.sol";
import {PerplOracleLib} from "../../src/libraries/PerplOracleLib.sol";

contract SettlerV1Test is Base {
    bytes32 internal constant SALT = bytes32(uint256(0xC0FFEE));

    /// @dev alice commits + reveals on BTC at entry 849_810 (1 decimal), horizon 1h.
    function _revealed(uint8 dir, uint16 tp, uint16 sl) internal returns (uint256 id) {
        bytes32 h = _hash(alice, BTC, dir, tp, sl, 3600, SALT);
        vm.prank(alice);
        id = registry.commit(BTC, h, 3600);
        registry.reveal(id, dir, tp, sl, SALT);
    }

    function _toHorizonWithPrice(uint256 id, uint256 price) internal {
        vm.warp(registry.getCall(id).horizonEnd);
        _setPrice(BTC, price);
    }

    function test_settle_revertsBeforeHorizon_andWhenNotRevealed() public {
        uint256 id = _revealed(1, 500, 300);
        uint64 end = registry.getCall(id).horizonEnd;
        vm.warp(end - 1);
        _setPrice(BTC, 849_810);
        vm.expectRevert(abi.encodeWithSelector(SettlerV1.TooEarly.selector, end));
        settlerV1.settle(id);

        // sealed-but-unrevealed call cannot be settled
        _register(bob, "bobby", false);
        _setPrice(ETH, 269_510); // refresh: the mock oracle must not be stale at commit
        bytes32 h = _hash(bob, ETH, 1, 500, 300, 3600, SALT);
        vm.prank(bob);
        uint256 id2 = registry.commit(ETH, h, 3600);
        vm.warp(block.timestamp + 4000);
        _setPrice(ETH, 269_510);
        vm.expectRevert(abi.encodeWithSelector(SettlerV1.NotRevealed.selector, id2));
        settlerV1.settle(id2);
    }

    function test_settle_requiresOracleStampedAtOrAfterHorizon() public {
        uint256 id = _revealed(1, 500, 300);
        uint64 end = registry.getCall(id).horizonEnd;
        vm.warp(end + 10);
        ex.setOracle(BTC, 850_660, end - 1, 1); // sample from before the horizon
        vm.expectRevert(abi.encodeWithSelector(SettlerV1.OracleBeforeHorizon.selector, end - 1, end));
        settlerV1.settle(id);

        ex.setOracle(BTC, 850_660, end, 1); // exactly at horizon is acceptable
        settlerV1.settle(id);
    }

    function test_settle_longGain_exactMath() public {
        uint256 id = _revealed(1, 500, 300);
        _toHorizonWithPrice(id, 850_660); // +850 / 849_810 = 10.002 bps -> truncates to 10
        int32 score = settlerV1.settle(id);
        assertEq(score, 10);
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(c.scoreBps, 10);
        assertEq(c.flags, settlerV1.FLAG_APPROX_ENDPOINT());
        assertEq(uint8(c.status), uint8(CallRegistry.Status.Settled));
    }

    function test_settle_shortFlipsSign() public {
        uint256 id = _revealed(2, 500, 300);
        _toHorizonWithPrice(id, 850_660);
        assertEq(settlerV1.settle(id), -10); // price rose, short loses
    }

    function test_settle_shortGainOnFall() public {
        uint256 id = _revealed(2, 500, 300);
        _toHorizonWithPrice(id, 839_810); // -10_000 / 849_810 = -117.67 -> -117 truncated; short +117
        assertEq(settlerV1.settle(id), 117);
    }

    function test_settle_clampsAtTakeProfit() public {
        uint256 id = _revealed(1, 500, 300);
        _toHorizonWithPrice(id, 1_000_000); // +17.6%
        assertEq(settlerV1.settle(id), 500);
    }

    function test_settle_clampsAtStopLoss() public {
        uint256 id = _revealed(1, 500, 300);
        _toHorizonWithPrice(id, 500_000); // -41%
        assertEq(settlerV1.settle(id), -300);
    }

    function test_settle_truncatesTowardZeroOnBothSigns() public {
        uint256 id = _revealed(1, 500, 300);
        _toHorizonWithPrice(id, 849_811); // +1/849_810 -> 0.0011 bps -> 0
        assertEq(settlerV1.settle(id), 0);

        _register(bob, "bobby", false);
        bytes32 h = _hash(bob, BTC, 1, 500, 300, 3600, SALT);
        vm.warp(block.timestamp + 1);
        _setPrice(BTC, 849_810);
        vm.prank(bob);
        uint256 id2 = registry.commit(BTC, h, 3600);
        registry.reveal(id2, 1, 500, 300, SALT);
        _toHorizonWithPrice(id2, 849_809); // -1 -> -0.0011 bps -> 0 (not -1)
        assertEq(settlerV1.settle(id2), 0);
    }

    function test_settle_lateFlag() public {
        uint256 id = _revealed(1, 500, 300);
        uint64 end = registry.getCall(id).horizonEnd;
        vm.warp(end + 181);
        ex.setOracle(BTC, 850_660, end + 181, 1); // oracle sample 181s after horizon
        settlerV1.settle(id);
        assertEq(registry.getCall(id).flags, settlerV1.FLAG_APPROX_ENDPOINT() | settlerV1.FLAG_LATE());
    }

    function test_settle_notLateAtExactThreshold() public {
        uint256 id = _revealed(1, 500, 300);
        uint64 end = registry.getCall(id).horizonEnd;
        vm.warp(end + 180);
        ex.setOracle(BTC, 850_660, end + 180, 1);
        settlerV1.settle(id);
        assertEq(registry.getCall(id).flags, settlerV1.FLAG_APPROX_ENDPOINT());
    }

    function test_settle_decimalsChangedReverts() public {
        uint256 id = _revealed(1, 500, 300);
        vm.warp(registry.getCall(id).horizonEnd);
        ex.setOracle(BTC, 8_506_600, block.timestamp, 2); // exchange re-scaled the market
        vm.expectRevert(abi.encodeWithSelector(SettlerV1.PriceDecimalsChanged.selector, uint8(1), uint8(2)));
        settlerV1.settle(id);
    }

    function test_settle_staleOracleReverts() public {
        uint256 id = _revealed(1, 500, 300);
        uint64 end = registry.getCall(id).horizonEnd;
        vm.warp(end + 500);
        ex.setOracle(BTC, 850_660, end + 1, 1); // 499 s old
        vm.expectRevert(abi.encodeWithSelector(PerplOracleLib.OracleStale.selector, BTC, uint256(499), uint256(MAX_ORACLE_AGE)));
        settlerV1.settle(id);
    }

    function test_settle_twiceReverts_andFreesSlotOnce() public {
        uint256 id = _revealed(1, 500, 300);
        _toHorizonWithPrice(id, 850_660);
        settlerV1.settle(id);
        vm.expectRevert(abi.encodeWithSelector(SettlerV1.NotRevealed.selector, id));
        settlerV1.settle(id);
        assertEq(registry.openCallCount(alice), 0);
        assertEq(registry.openCallId(alice, BTC), 0);
    }

    function testFuzz_settle_scoreAlwaysWithinBounds_andMatchesIndependentFormula(
        uint8 dirSeed,
        uint16 tp,
        uint16 sl,
        uint128 exitPrice
    ) public {
        uint8 dir = uint8(bound(dirSeed, 1, 2));
        tp = uint16(bound(tp, 1, 3000));
        sl = uint16(bound(sl, 1, 1500));
        exitPrice = uint128(bound(exitPrice, 1, 100_000_000));
        uint256 id = _revealed(dir, tp, sl);
        _toHorizonWithPrice(id, exitPrice);
        int32 score = settlerV1.settle(id);

        // independent recomputation (different code path: int256 math in the test)
        int256 raw = (int256(uint256(exitPrice)) - 849_810) * 10_000 / 849_810;
        if (dir == 2) raw = -raw;
        int256 want = raw < -int256(uint256(sl)) ? -int256(uint256(sl)) : (raw > int256(uint256(tp)) ? int256(uint256(tp)) : raw);
        assertEq(int256(score), want);
        assertGe(score, -int32(uint32(sl)));
        assertLe(score, int32(uint32(tp)));
    }
}
