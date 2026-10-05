// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "../Base.t.sol";
import {CallRegistry} from "../../src/CallRegistry.sol";
import {PriceTape} from "../../src/PriceTape.sol";
import {SettlerV2} from "../../src/SettlerV2.sol";
import {IPerplExchange} from "../../src/interfaces/IPerplExchange.sol";

contract SettlerV2Test is Base {
    PriceTape internal tape;
    SettlerV2 internal v2;
    address internal forwarder = makeAddr("forwarder");
    uint32 internal constant WINDOW = 900;
    bytes32 internal constant SALT = keccak256("salt");
    uint256 internal t0; // entry oracle timestamp
    uint256 internal constant ENTRY = 849_810; // BTC, 1 decimal

    function setUp() public override {
        super.setUp();
        tape = new PriceTape(IPerplExchange(address(ex)), MAX_ORACLE_AGE, forwarder);
        v2 = new SettlerV2(registry, tape, WINDOW, forwarder);
        vm.prank(owner);
        registry.proposeSettler(address(v2));
        vm.warp(block.timestamp + SETTLER_DELAY);
        registry.activateSettler();
        // refresh the oracle after the warp and record the entry time
        t0 = block.timestamp;
        ex.setOracle(BTC, ENTRY, t0, 1);
    }

    /// @dev alice commits and reveals a BTC call (dir 1 long / 2 short) at the current oracle (ENTRY, ts t0)
    function _revealed(uint8 dir, uint16 tp, uint16 sl) internal returns (uint256 id) {
        bytes32 h = _hash(alice, BTC, dir, tp, sl, 3600, SALT); // external call first: it would consume the prank
        vm.prank(alice);
        id = registry.commit(BTC, h, 3600);
        registry.reveal(id, dir, tp, sl, SALT);
    }

    function _push(uint256 at, uint256 price) internal returns (uint32 idx) {
        vm.warp(at);
        ex.setOracle(BTC, price, at, 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = BTC;
        tape.sample(ids);
        idx = uint32(tape.sampleCount(BTC) - 1);
    }

    function _end(uint256 id) internal view returns (uint256) {
        return registry.getCall(id).horizonEnd;
    }

    function _finalizeAfterWindow(uint256 id) internal {
        vm.warp(block.timestamp + WINDOW);
        v2.finalize(id);
    }

    // ---------------------------------------------------------------- touches
    function test_longTakeProfitTouch_scoresPlusTp_andIgnoresTheEndpoint() public {
        uint256 id = _revealed(1, 100, 100);
        uint32 up = _push(t0 + 600, 858_400); // +1.01% => touches +100
        _push(t0 + 1800, 800_000); // price later collapses: irrelevant, TP was touched first
        uint32 end = _push(_end(id), 800_000);
        end; // endpoint exists but is not the deciding sample
        v2.propose(id, up);
        _finalizeAfterWindow(id);
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(uint8(c.status), uint8(CallRegistry.Status.Settled));
        assertEq(c.scoreBps, 100);
        assertEq(c.flags, v2.FLAG_PATH_TAPE());
        assertEq(registry.openCallCount(alice), 0);
    }

    function test_longStopLossTouch_scoresMinusSl_evenIfPriceRecovers() public {
        uint256 id = _revealed(1, 300, 100);
        uint32 down = _push(t0 + 300, 840_000); // -1.15%
        _push(t0 + 3000, 900_000); // recovers well past TP, too late
        _push(_end(id), 900_000);
        v2.propose(id, down);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).scoreBps, -100);
    }

    function test_shortTouchesMirrorLong() public {
        // short gains when the price falls: +100 on a -1.15% move
        uint256 id = _revealed(2, 100, 100);
        uint32 fall = _push(t0 + 300, 840_000);
        _push(_end(id), 900_000);
        v2.propose(id, fall);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).scoreBps, 100);
        // short loses when the price rises: -100 on a +1.1% move (fresh slot after settle; commit again)
        bytes32 salt2 = keccak256("salt2");
        bytes32 h = _hash(alice, BTC, 2, 100, 100, 3600, salt2);
        uint256 t1 = block.timestamp;
        ex.setOracle(BTC, ENTRY, t1, 1);
        vm.prank(alice);
        uint256 id2 = registry.commit(BTC, h, 3600);
        registry.reveal(id2, 2, 100, 100, salt2);
        uint32 rise = _push(t1 + 300, 859_300);
        _push(_end(id2), 800_000);
        v2.propose(id2, rise);
        _finalizeAfterWindow(id2);
        assertEq(registry.getCall(id2).scoreBps, -100);
    }

    function test_touch_exactlyAtTpAndExactlyAtSlCounts() public {
        // raw = (p - entry) * 10000 / entry, truncated toward zero: 858_309 gives exactly +100, 841_311 exactly -100
        uint256 id = _revealed(1, 100, 100);
        uint32 atTp = _push(t0 + 100, 858_309);
        _push(_end(id), 850_000);
        v2.propose(id, atTp);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).scoreBps, 100);

        bytes32 salt2 = keccak256("salt3");
        bytes32 h = _hash(alice, BTC, 1, 100, 100, 3600, salt2);
        uint256 t1 = block.timestamp;
        ex.setOracle(BTC, ENTRY, t1, 1);
        vm.prank(alice);
        uint256 id2 = registry.commit(BTC, h, 3600);
        registry.reveal(id2, 1, 100, 100, salt2);
        uint32 atSl = _push(t1 + 100, 841_311);
        _push(_end(id2), 850_000);
        v2.propose(id2, atSl);
        _finalizeAfterWindow(id2);
        assertEq(registry.getCall(id2).scoreBps, -100);

        // one unit short of the boundary does not touch
        bytes32 salt3 = keccak256("salt4");
        bytes32 h3 = _hash(alice, BTC, 1, 100, 100, 3600, salt3);
        uint256 t2 = block.timestamp;
        ex.setOracle(BTC, ENTRY, t2, 1);
        vm.prank(alice);
        uint256 id3 = registry.commit(BTC, h3, 3600);
        registry.reveal(id3, 1, 100, 100, salt3);
        uint32 almost = _push(t2 + 100, 858_307); // (8497*10000)/849810 = 99.99 -> 99
        _push(_end(id3), 850_000);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NotATouch.selector, uint256(almost)));
        v2.propose(id3, almost);
    }

    function test_proposeBeforeHorizonReverts() public {
        uint256 id = _revealed(1, 100, 100);
        uint32 up = _push(t0 + 300, 858_400);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.TooEarly.selector, uint64(_end(id))));
        v2.propose(id, up);
    }

    function test_propose_nonTouchingPathSampleReverts() public {
        uint256 id = _revealed(1, 100, 100);
        uint32 mid = _push(t0 + 300, 850_500); // +0.08%
        _push(_end(id), 850_500);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NotATouch.selector, uint256(mid)));
        v2.propose(id, mid);
    }

    function test_propose_sampleAtOrBeforeEntryRevertsAndIndexOutOfRangeReverts() public {
        uint256 id = _revealed(1, 100, 100);
        // a sample whose oracle ts equals the entry ts is the entry itself
        uint256[] memory ids = new uint256[](1);
        ids[0] = BTC;
        tape.sample(ids); // records (ENTRY, t0)
        _push(_end(id), 858_400);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.SampleOutsidePath.selector, uint64(t0), uint64(t0), uint64(_end(id))));
        v2.propose(id, 0);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NoSuchSample.selector, uint256(7), uint256(2)));
        v2.propose(id, 7);
    }

    // ---------------------------------------------------------------- endpoint
    function test_endpoint_noTouch_scoresFirstSampleAtOrAfterHorizon() public {
        uint256 id = _revealed(1, 200, 200);
        _push(t0 + 600, 851_000);
        uint32 end = _push(_end(id), 853_000); // +0.37% => 37 bps (truncated)
        _push(_end(id) + 40, 880_000); // a later, more convenient sample must not be usable
        v2.propose(id, end);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).scoreBps, 37);
        assertEq(registry.getCall(id).flags, v2.FLAG_PATH_TAPE());
    }

    function test_endpoint_cannotCherryPickALaterSample() public {
        uint256 id = _revealed(1, 500, 500);
        uint32 first = _push(_end(id) + 10, 851_000);
        uint32 later = _push(_end(id) + 70, 880_000);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NotFirstAfterHorizon.selector, uint256(later)));
        v2.propose(id, later);
        v2.propose(id, first);
    }

    function test_endpoint_clampsIntoOwnBounds() public {
        uint256 id = _revealed(1, 100, 100);
        // a +5% sample exists only AT the horizon, so there is no earlier path sample: endpoint clamps to tp
        uint32 end = _push(_end(id), 892_300);
        v2.propose(id, end);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).scoreBps, 100);
    }

    function test_endpoint_lateFlag() public {
        uint256 id = _revealed(1, 500, 500);
        uint32 end = _push(_end(id) + 181, 851_000);
        v2.propose(id, end);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).flags, v2.FLAG_PATH_TAPE() | v2.FLAG_LATE());
    }

    function test_endpoint_notLateAtExactThreshold() public {
        uint256 id = _revealed(1, 500, 500);
        uint32 end = _push(_end(id) + 180, 851_000);
        v2.propose(id, end);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).flags, v2.FLAG_PATH_TAPE());
    }

    // ---------------------------------------------------------------- disputes
    function test_dispute_overturnsAnEndpointProposalWithAnEarlierTouch() public {
        uint256 id = _revealed(1, 100, 100);
        uint32 touch = _push(t0 + 600, 858_400); // +100 touched in the path
        uint32 end = _push(_end(id), 849_900); // back to ~0 at the horizon
        v2.propose(id, end); // a lazy / wrong proposal ignores the touch
        v2.dispute(id, touch);
        _finalizeAfterWindow(id);
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(c.scoreBps, 100);
        assertEq(c.flags, v2.FLAG_PATH_TAPE() | v2.FLAG_DISPUTED());
    }

    function test_dispute_earlierTouchBeatsLaterTouch_butNotViceVersa() public {
        uint256 id = _revealed(1, 300, 100);
        uint32 sl = _push(t0 + 200, 840_000); // -1.15% => SL touched first
        uint32 tp = _push(t0 + 400, 880_000); // then +3.5% => TP touched later
        _push(_end(id), 860_000);
        v2.propose(id, tp); // proposer claims the TP
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NotEarlier.selector, tp, tp));
        v2.dispute(id, tp);
        v2.dispute(id, sl); // the earlier SL wins
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NotEarlier.selector, sl, tp)); // cannot swap back to the later one
        v2.dispute(id, tp);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).scoreBps, -100);
    }

    function test_dispute_withNonTouchOrOutOfPathSampleReverts() public {
        uint256 id = _revealed(1, 100, 100);
        uint32 mid = _push(t0 + 300, 850_000);
        uint32 end = _push(_end(id), 849_900);
        v2.propose(id, end);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NotATouch.selector, uint256(mid)));
        v2.dispute(id, mid);
        // the endpoint sample itself is not a path sample
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.SampleOutsidePath.selector, uint64(_end(id)), uint64(t0), uint64(_end(id))));
        v2.dispute(id, end);
    }

    function test_dispute_afterWindowRevertsAndFinalizeBeforeWindowReverts() public {
        uint256 id = _revealed(1, 100, 100);
        uint32 touch = _push(t0 + 300, 858_400);
        uint32 end = _push(_end(id), 849_900);
        v2.propose(id, end);
        uint64 closes = uint64(block.timestamp) + WINDOW;
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.WindowOpen.selector, closes));
        v2.finalize(id);
        vm.warp(block.timestamp + WINDOW - 1);
        v2.dispute(id, touch); // last second still allowed
        vm.warp(block.timestamp + 1);
        v2.finalize(id);
        // a second dispute attempt now fails (finalized)
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.AlreadyFinalized.selector, id));
        v2.dispute(id, touch);
    }

    function test_dispute_atExactClose_reverts() public {
        uint256 id = _revealed(1, 100, 100);
        uint32 touch = _push(t0 + 300, 858_400);
        uint32 end = _push(_end(id), 849_900);
        v2.propose(id, end);
        uint64 closes = uint64(block.timestamp) + WINDOW;
        vm.warp(closes);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.WindowClosed.selector, closes));
        v2.dispute(id, touch);
    }

    function test_proposeTwiceAndFinalizeTwiceRevert() public {
        uint256 id = _revealed(1, 500, 500);
        uint32 end = _push(_end(id), 851_000);
        v2.propose(id, end);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.AlreadyProposed.selector, id));
        v2.propose(id, end);
        _finalizeAfterWindow(id);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.AlreadyFinalized.selector, id));
        v2.finalize(id);
    }

    function test_finalizeWithoutProposalReverts() public {
        uint256 id = _revealed(1, 500, 500);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NoProposal.selector, id));
        v2.finalize(id);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NoProposal.selector, id));
        v2.dispute(id, 0);
    }

    function test_unrevealedOrAlreadyClosedCallCannotBeProposed() public {
        bytes32 h = _hash(alice, BTC, 1, 100, 100, 3600, SALT);
        vm.prank(alice);
        uint256 id = registry.commit(BTC, h, 3600);
        vm.warp(block.timestamp + 4000);
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NotRevealed.selector, id));
        v2.propose(id, 0);
    }

    function test_decimalsMismatchBetweenCallAndTapeReverts() public {
        uint256 id = _revealed(1, 100, 100);
        // the exchange re-scales BTC after the call was committed: the tape records the new scale
        vm.warp(t0 + 100);
        ex.setOracle(BTC, 8_584_000, t0 + 100, 2);
        uint256[] memory ids = new uint256[](1);
        ids[0] = BTC;
        tape.sample(ids);
        vm.warp(_end(id));
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.DecimalsMismatch.selector, uint8(1), uint8(2)));
        v2.propose(id, 0);
    }

    // ---------------------------------------------------------------- CRE report path
    function test_onReport_onlyForwarder() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSelector(SettlerV2.NotForwarder.selector, makeAddr("stranger")));
        v2.onReport("", abi.encode(new uint256[](0), new uint32[](0)));
    }

    function test_onReport_batchProposesAndSkipsBadItems() public {
        uint256 id = _revealed(1, 500, 500);
        uint32 end = _push(_end(id), 851_000);
        uint256[] memory ids = new uint256[](2);
        uint32[] memory idx = new uint32[](2);
        ids[0] = 9999; // unknown call
        idx[0] = 0;
        ids[1] = id;
        idx[1] = end;
        vm.prank(forwarder);
        v2.onReport("", abi.encode(ids, idx));
        (uint64 proposedAt,,,,,) = v2.proposals(id);
        assertGt(proposedAt, 0);
        (uint64 none,,,,,) = v2.proposals(9999);
        assertEq(none, 0);
    }

    function test_onReport_aForgedClaimStillHasToPassTheTape() public {
        uint256 id = _revealed(1, 100, 100);
        uint32 mid = _push(t0 + 300, 850_000);
        _push(_end(id), 850_000);
        uint256[] memory ids = new uint256[](1);
        uint32[] memory idx = new uint32[](1);
        ids[0] = id;
        idx[0] = mid; // a report claims a touch that did not happen
        vm.prank(forwarder);
        v2.onReport("", abi.encode(ids, idx)); // does not revert (item skipped) ...
        (uint64 proposedAt,,,,,) = v2.proposals(id);
        assertEq(proposedAt, 0); // ... and nothing was proposed
    }

    // ---------------------------------------------------------------- settler rotation facts
    function test_v1SettledCallsStayFinal_andOldSettlerIsPowerless() public {
        // a call settled BEFORE the rotation keeps its V1 result; V1 can no longer close anything
        // (the rotation happened in setUp, so settle one with V1 first in a fresh registry-less way is covered live;
        // here: after rotation V1 has no power)
        uint256 id = _revealed(1, 500, 500);
        vm.warp(_end(id));
        ex.setOracle(BTC, 851_000, _end(id), 1);
        vm.expectRevert(CallRegistry.NotSettler.selector);
        settlerV1.settle(id);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(SettlerV2.ZeroAddress.selector);
        new SettlerV2(CallRegistry(address(0)), tape, WINDOW, forwarder);
        vm.expectRevert(SettlerV2.ZeroAddress.selector);
        new SettlerV2(registry, PriceTape(address(0)), WINDOW, forwarder);
        vm.expectRevert(SettlerV2.ZeroAddress.selector);
        new SettlerV2(registry, tape, WINDOW, address(0));
    }

    // ---------------------------------------------------------------- property: an honest proposer == an independent reference
    /// @dev reference: first path sample (ts in (t0, end)) whose signed return crosses tp or -sl, else the first sample >= end clamped
    function _reference(uint8 dir, uint16 tp, uint16 sl, uint256[] memory prices, uint256[] memory times, uint256 end)
        internal
        pure
        returns (int256 score, uint256 idx)
    {
        for (uint256 i = 0; i < prices.length; i++) {
            int256 raw = (int256(prices[i]) - int256(ENTRY)) * 10_000 / int256(ENTRY);
            if (dir == 2) raw = -raw;
            if (times[i] < end) {
                if (raw >= int256(uint256(tp))) return (int256(uint256(tp)), i);
                if (raw <= -int256(uint256(sl))) return (-int256(uint256(sl)), i);
            } else {
                int256 lo = -int256(uint256(sl));
                int256 hi = int256(uint256(tp));
                return (raw < lo ? lo : (raw > hi ? hi : raw), i);
            }
        }
        revert("reference: no endpoint sample");
    }

    function testFuzz_honestProposerMatchesReference(uint8 dir, uint16 tp, uint16 sl, uint256 seed) public {
        dir = uint8(bound(dir, 1, 2));
        tp = uint16(bound(tp, 1, 3000));
        sl = uint16(bound(sl, 1, 1500));
        uint256 id = _revealed(dir, tp, sl);
        uint256 end = _end(id);
        uint256 n = 12;
        uint256[] memory prices = new uint256[](n);
        uint256[] memory times = new uint256[](n);
        for (uint256 i = 0; i < n; i++) {
            // 11 path samples spread over the horizon (strictly increasing, strictly inside (t0, end)), then the endpoint
            times[i] = i < n - 1 ? t0 + 1 + (i * (end - t0 - 2)) / (n - 1) : end;
            // random price within [-12%, +12%] of entry
            uint256 r = uint256(keccak256(abi.encode(seed, i))) % 2400;
            prices[i] = ENTRY * (8800 + r) / 10_000;
            _push(times[i], prices[i]);
        }
        (int256 expected, uint256 idx) = _reference(dir, tp, sl, prices, times, end);
        v2.propose(id, uint32(idx));
        _finalizeAfterWindow(id);
        assertEq(int256(registry.getCall(id).scoreBps), expected);
        // and the score is always inside the call's own bounds
        assertGe(int256(registry.getCall(id).scoreBps), -int256(uint256(sl)));
        assertLe(int256(registry.getCall(id).scoreBps), int256(uint256(tp)));
    }

    /// @dev A dishonest proposer who claims the endpoint when an earlier touch exists is always overturnable, and the
    ///      result then equals the reference.
    function testFuzz_dishonestEndpointClaimIsOverturned(uint16 tp, uint16 sl, uint256 seed) public {
        tp = uint16(bound(tp, 1, 3000));
        sl = uint16(bound(sl, 1, 1500));
        uint256 id = _revealed(1, tp, sl);
        uint256 end = _end(id);
        // path sample 1 is a guaranteed TP touch, then the price returns near entry
        uint256 touchPrice = ENTRY * (10_000 + uint256(tp) + 5) / 10_000 + 1;
        uint32 touch = _push(t0 + 100, touchPrice);
        _push(t0 + 200 + (seed % 1000), ENTRY);
        uint32 endIdx = _push(end, ENTRY);
        v2.propose(id, endIdx);
        v2.dispute(id, touch);
        _finalizeAfterWindow(id);
        assertEq(registry.getCall(id).scoreBps, int32(uint32(tp)));
    }
}
