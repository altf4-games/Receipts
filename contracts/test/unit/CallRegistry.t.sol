// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "../Base.t.sol";
import {CallRegistry, ICuratorBonded} from "../../src/CallRegistry.sol";
import {PerplOracleLib} from "../../src/libraries/PerplOracleLib.sol";
import {IPerplExchange} from "../../src/interfaces/IPerplExchange.sol";
import {MockPerplExchange} from "../mocks/MockPerplExchange.sol";

contract CallRegistryTest is Base {
    bytes32 internal constant SALT = bytes32(uint256(0xC0FFEE));

    // ------------------------------------------------------------ A1: price is snapshotted inside commit

    function test_A1_commitSnapshotsOracle_notCallerSupplied_andLaterMovesDontChangeIt() public {
        uint256 t0 = block.timestamp;
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(c.entryPNS, 849_810);
        assertEq(c.entryOracleTs, t0);
        assertEq(c.priceDecimals, 1);
        assertEq(c.commitBlock, block.number);
        assertEq(c.commitTime, t0);
        assertEq(c.horizonEnd, t0 + 3600);
        assertEq(uint8(c.status), uint8(CallRegistry.Status.Sealed));

        vm.warp(block.timestamp + 100);
        _setPrice(BTC, 900_000); // oracle moves after commit
        assertEq(registry.getCall(id).entryPNS, 849_810, "entry must be frozen at commit");
    }

    function test_A1_commitAtDifferentPrices_storesEach() public {
        uint256 id1 = _commitLong(alice, BTC, 500, 300, SALT);
        _register(bob, "bobby", false);
        _setPrice(BTC, 851_000);
        uint256 id2 = _commitLong(bob, BTC, 500, 300, SALT);
        assertEq(registry.getCall(id1).entryPNS, 849_810);
        assertEq(registry.getCall(id2).entryPNS, 851_000);
    }

    // ------------------------------------------------------------ A2: one open call per (curator, market)

    function test_A2_secondOpenCallSameMarketReverts_otherMarketOk() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        bytes32 h = _hash(alice, BTC, 2, 500, 300, 3600, bytes32(uint256(2)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.OpenCallExists.selector, BTC, id));
        registry.commit(BTC, h, 3600);

        uint256 id2 = _commitLong(alice, ETH, 500, 300, SALT); // different market is fine
        assertEq(id2, id + 1);
        assertEq(registry.openCallCount(alice), 2);
    }

    function test_A2_slotFreedAfterExpire_soCuratorCanCommitAgain() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        vm.warp(block.timestamp + 3601);
        registry.expire(id);
        _setPrice(BTC, 849_810);
        uint256 id2 = _commitLong(alice, BTC, 500, 300, bytes32(uint256(9)));
        assertEq(id2, id + 1);
        assertEq(registry.openCallCount(alice), 1);
    }

    // ------------------------------------------------------------ A3 / A20: expiry and boundaries

    function test_A3_expire_scoresPenalty_andFreesSlot() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        vm.warp(block.timestamp + 3601);
        vm.expectEmit(true, false, false, false);
        emit CallRegistry.Expired(id);
        registry.expire(id); // anyone
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(uint8(c.status), uint8(CallRegistry.Status.Expired));
        assertEq(c.scoreBps, -3000);
        assertEq(registry.openCallId(alice, BTC), 0);
        assertEq(registry.openCallCount(alice), 0);
    }

    function test_A20_expireBoundary_atHorizonEndReverts_oneSecondAfterOk() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        uint64 end = registry.getCall(id).horizonEnd;
        vm.warp(end);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.NotYetExpired.selector, end));
        registry.expire(id);
        vm.warp(end + 1);
        registry.expire(id);
    }

    function test_A20_revealBoundary_atHorizonEndOk_oneSecondAfterReverts() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        uint256 id2;
        {
            _register(bob, "bobby", false);
            id2 = _commitLong(bob, BTC, 500, 300, SALT);
        }
        uint64 end = registry.getCall(id).horizonEnd;
        vm.warp(end);
        registry.reveal(id, 1, 500, 300, SALT); // inclusive
        assertEq(uint8(registry.getCall(id).status), uint8(CallRegistry.Status.Revealed));

        vm.warp(end + 1);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.RevealWindowClosed.selector, registry.getCall(id2).horizonEnd));
        registry.reveal(id2, 1, 500, 300, SALT);
    }

    function test_A20_horizonBounds() public {
        bytes32 h = _hash(alice, BTC, 1, 500, 300, MIN_HORIZON - 1, SALT);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CallRegistry.HorizonOutOfRange.selector, MIN_HORIZON - 1, MIN_HORIZON, uint32(7 days))
        );
        registry.commit(BTC, h, MIN_HORIZON - 1);

        h = _hash(alice, BTC, 1, 500, 300, 7 days + 1, SALT);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CallRegistry.HorizonOutOfRange.selector, uint32(7 days) + 1, MIN_HORIZON, uint32(7 days))
        );
        registry.commit(BTC, h, 7 days + 1);

        // exact bounds are accepted
        h = _hash(alice, BTC, 1, 500, 300, MIN_HORIZON, SALT);
        vm.prank(alice);
        registry.commit(BTC, h, MIN_HORIZON);
        h = _hash(alice, ETH, 1, 500, 300, 7 days, SALT);
        vm.prank(alice);
        registry.commit(ETH, h, 7 days);
    }

    // ------------------------------------------------------------ reveal

    function test_reveal_byThirdParty_works_andStoresParams() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        vm.prank(keeper);
        registry.reveal(id, 1, 500, 300, SALT);
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(uint8(c.status), uint8(CallRegistry.Status.Revealed));
        assertEq(c.direction, 1);
        assertEq(c.tpBps, 500);
        assertEq(c.slBps, 300);
        assertEq(registry.openCallId(alice, BTC), id, "slot stays occupied until scored");
    }

    function test_reveal_wrongSaltOrAnyParamReverts() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        vm.expectRevert(CallRegistry.BadReveal.selector);
        registry.reveal(id, 1, 500, 300, bytes32(uint256(1))); // wrong salt
        vm.expectRevert(CallRegistry.BadReveal.selector);
        registry.reveal(id, 2, 500, 300, SALT); // flipped direction
        vm.expectRevert(CallRegistry.BadReveal.selector);
        registry.reveal(id, 1, 501, 300, SALT); // tp
        vm.expectRevert(CallRegistry.BadReveal.selector);
        registry.reveal(id, 1, 500, 301, SALT); // sl
        registry.reveal(id, 1, 500, 300, SALT); // the right one still works
    }

    function test_reveal_twiceAndAfterExpireRevert() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        registry.reveal(id, 1, 500, 300, SALT);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.WrongStatus.selector, id, CallRegistry.Status.Revealed));
        registry.reveal(id, 1, 500, 300, SALT);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.UnknownCall.selector, 999));
        registry.reveal(999, 1, 500, 300, SALT);
    }

    function test_A5_invalidParams_becomeInvalid_scorePenalty_slotFreed() public {
        uint8[5] memory dirs = [uint8(3), 1, 1, 1, 0];
        uint16[5] memory tps = [uint16(500), 0, 3001, 500, 500];
        uint16[5] memory sls = [uint16(300), 300, 300, 1501, 0];
        for (uint256 i = 0; i < 5; i++) {
            address who = makeAddr(string.concat("c", vm.toString(i)));
            _register(who, string.concat("curator", vm.toString(i)), false);
            bytes32 salt = bytes32(i + 1);
            bytes32 h = _hash(who, BTC, dirs[i], tps[i], sls[i], 3600, salt);
            vm.prank(who);
            uint256 id = registry.commit(BTC, h, 3600);

            registry.reveal(id, dirs[i], tps[i], sls[i], salt);
            CallRegistry.Call memory c = registry.getCall(id);
            assertEq(uint8(c.status), uint8(CallRegistry.Status.Invalid), "invalid params must not score normally");
            assertEq(c.scoreBps, -3000);
            assertEq(registry.openCallId(who, BTC), 0);
        }
    }

    // ------------------------------------------------------------ A6: replay across deployments

    function test_A6_hashFromOneDeploymentCannotRevealOnAnother() public {
        CallRegistry other = new CallRegistry(
            owner, ICuratorBonded(address(curators)), IPerplExchange(address(ex)), address(settlerV1), MIN_HORIZON, MAX_ORACLE_AGE
        );
        vm.prank(owner);
        other.setMarketAllowed(BTC, true);

        bytes32 hOnA = _hash(alice, BTC, 1, 500, 300, 3600, SALT);
        bytes32 hOnB = other.hashCall(alice, BTC, 1, 500, 300, 3600, SALT);
        assertTrue(hOnA != hOnB, "address(this) must be inside the hash");

        // alice commits the hash computed for deployment A onto deployment B: reveal can never match
        vm.prank(alice);
        uint256 id = other.commit(BTC, hOnA, 3600);
        vm.expectRevert(CallRegistry.BadReveal.selector);
        other.reveal(id, 1, 500, 300, SALT);
    }

    function test_A6_hashBoundToChainId() public {
        bytes32 before_ = _hash(alice, BTC, 1, 500, 300, 3600, SALT);
        vm.chainId(10143);
        assertTrue(before_ != _hash(alice, BTC, 1, 500, 300, 3600, SALT));
    }

    // ------------------------------------------------------------ A7 / A8: oracle safety

    function test_A7_staleOracleReverts_boundaryExact() public {
        ex.setOracle(BTC, 849_810, block.timestamp - MAX_ORACLE_AGE, 1); // age == max -> ok
        bytes32 h = _hash(alice, BTC, 1, 500, 300, 3600, SALT);
        vm.prank(alice);
        registry.commit(BTC, h, 3600);

        ex.setOracle(ETH, 269_510, block.timestamp - MAX_ORACLE_AGE - 1, 2); // age == max+1 -> stale
        h = _hash(alice, ETH, 1, 500, 300, 3600, SALT);
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(PerplOracleLib.OracleStale.selector, ETH, uint256(MAX_ORACLE_AGE) + 1, uint256(MAX_ORACLE_AGE))
        );
        registry.commit(ETH, h, 3600);
    }

    function test_A7_oracleFromFuture_toleranceAndRevert() public {
        ex.setOracle(BTC, 849_810, block.timestamp + 5, 1); // within tolerance
        bytes32 h = _hash(alice, BTC, 1, 500, 300, 3600, SALT);
        vm.prank(alice);
        registry.commit(BTC, h, 3600);

        ex.setOracle(ETH, 269_510, block.timestamp + 6, 2);
        h = _hash(alice, ETH, 1, 500, 300, 3600, SALT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerplOracleLib.OracleFromFuture.selector, ETH, block.timestamp + 6, block.timestamp));
        registry.commit(ETH, h, 3600);
    }

    function test_A8_zeroPrice_ignOracle_unknownMarket_notAllowed() public {
        ex.setOracle(BTC, 0, block.timestamp, 1);
        bytes32 h = _hash(alice, BTC, 1, 500, 300, 3600, SALT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerplOracleLib.OracleZeroPrice.selector, BTC));
        registry.commit(BTC, h, 3600);

        ex.setOracle(BTC, 849_810, block.timestamp, 1);
        ex.setIgnOracle(BTC, true);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(PerplOracleLib.OracleIgnored.selector, BTC));
        registry.commit(BTC, h, 3600);

        // allowlisted but unknown to the exchange: the exchange's own revert bubbles up
        vm.prank(owner);
        registry.setMarketAllowed(999, true);
        h = _hash(alice, 999, 1, 500, 300, 3600, SALT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockPerplExchange.ContractDoesNotExist.selector, 999));
        registry.commit(999, h, 3600);

        // not allowlisted at all
        h = _hash(alice, 12345, 1, 500, 300, 3600, SALT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.MarketNotAllowed.selector, 12345));
        registry.commit(12345, h, 3600);
    }

    // ------------------------------------------------------------ commit guards

    function test_commit_requiresBond_andNonZeroHash() public {
        bytes32 h = _hash(bob, BTC, 1, 500, 300, 3600, SALT);
        vm.prank(bob); // never registered
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.NotBonded.selector, bob));
        registry.commit(BTC, h, 3600);

        vm.prank(alice);
        vm.expectRevert(CallRegistry.ZeroHash.selector);
        registry.commit(BTC, bytes32(0), 3600);
    }

    function test_removedMarket_blocksNewCommitsOnly() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        vm.prank(owner);
        registry.setMarketAllowed(BTC, false);
        // existing call still lifecycle-able
        registry.reveal(id, 1, 500, 300, SALT);
        _register(bob, "bobby", false);
        bytes32 h = _hash(bob, BTC, 1, 500, 300, 3600, SALT);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.MarketNotAllowed.selector, BTC));
        registry.commit(BTC, h, 3600);
    }

    // ------------------------------------------------------------ close / settler rotation / owner

    function test_close_onlySettler_statusAndBounds() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        vm.prank(address(settlerV1));
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.WrongStatus.selector, id, CallRegistry.Status.Sealed));
        registry.close(id, 0, 0); // not revealed yet

        registry.reveal(id, 1, 500, 300, SALT);

        vm.prank(alice);
        vm.expectRevert(CallRegistry.NotSettler.selector);
        registry.close(id, 100, 0);

        vm.startPrank(address(settlerV1));
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.ScoreOutOfBounds.selector, int32(501), int32(-300), int32(500)));
        registry.close(id, 501, 0);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.ScoreOutOfBounds.selector, int32(-301), int32(-300), int32(500)));
        registry.close(id, -301, 0);
        registry.close(id, 500, 7); // inclusive upper bound
        vm.stopPrank();

        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(uint8(c.status), uint8(CallRegistry.Status.Settled));
        assertEq(c.scoreBps, 500);
        assertEq(c.flags, 7);
        assertEq(registry.openCallId(alice, BTC), 0);
    }

    function test_A14_settlerRotation_emitsEvent_oldSettlerLosesPower() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, SALT);
        registry.reveal(id, 1, 500, 300, SALT);
        address newSettler = makeAddr("settlerV2");

        vm.expectEmit(true, true, false, false);
        emit CallRegistry.SettlerChanged(address(settlerV1), newSettler);
        vm.prank(owner);
        registry.setSettler(newSettler);

        vm.prank(address(settlerV1));
        vm.expectRevert(CallRegistry.NotSettler.selector);
        registry.close(id, 0, 0);

        vm.prank(newSettler); // a v2 can settle what v1 never did
        registry.close(id, -300, 0);
        assertEq(registry.getCall(id).scoreBps, -300);
    }

    function test_owner_onlyFunctions_andOracleAgeBounds() public {
        vm.startPrank(alice);
        vm.expectRevert();
        registry.setSettler(alice);
        vm.expectRevert();
        registry.setMarketAllowed(1, true);
        vm.expectRevert();
        registry.setMaxOracleAge(100);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(CallRegistry.OracleAgeOutOfRange.selector);
        registry.setMaxOracleAge(29);
        vm.expectRevert(CallRegistry.OracleAgeOutOfRange.selector);
        registry.setMaxOracleAge(601);
        registry.setMaxOracleAge(600);
        vm.expectRevert(CallRegistry.ZeroAddress.selector);
        registry.setSettler(address(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ A4 + fuzz

    function testFuzz_A4_penaltyNeverBeatsRevealing_andHedgedPairNeverPositive(uint16 tp, uint16 sl) public pure {
        tp = uint16(bound(tp, 1, 3000));
        sl = uint16(bound(sl, 1, 1500));
        int256 penalty = -3000;
        // not revealing a call is never better than revealing it at its worst outcome
        assertLt(penalty, -int256(uint256(sl)));
        // a hedged pair: best winner (+tp) plus an unrevealed loser (penalty) is never positive
        assertLe(int256(uint256(tp)) + penalty, 0);
    }

    function testFuzz_commitRevealRoundtrip(uint8 dir, uint16 tp, uint16 sl, bytes32 salt, uint32 horizon) public {
        dir = uint8(bound(dir, 1, 2));
        tp = uint16(bound(tp, 1, 3000));
        sl = uint16(bound(sl, 1, 1500));
        horizon = uint32(bound(horizon, MIN_HORIZON, 7 days));
        bytes32 h = _hash(alice, BTC, dir, tp, sl, horizon, salt);
        vm.prank(alice);
        uint256 id = registry.commit(BTC, h, horizon);
        registry.reveal(id, dir, tp, sl, salt);
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(uint8(c.status), uint8(CallRegistry.Status.Revealed));
        assertEq(c.direction, dir);
        assertEq(c.tpBps, tp);
        assertEq(c.slBps, sl);
    }

    function testFuzz_anyParamChangeBreaksReveal(uint8 dir, uint16 tp, uint16 sl, bytes32 salt, uint8 which) public {
        dir = uint8(bound(dir, 1, 2));
        tp = uint16(bound(tp, 2, 2999));
        sl = uint16(bound(sl, 2, 1499));
        bytes32 h = _hash(alice, BTC, dir, tp, sl, 3600, salt);
        vm.prank(alice);
        uint256 id = registry.commit(BTC, h, 3600);
        which = which % 4;
        vm.expectRevert(CallRegistry.BadReveal.selector);
        if (which == 0) registry.reveal(id, dir == 1 ? 2 : 1, tp, sl, salt);
        else if (which == 1) registry.reveal(id, dir, tp + 1, sl, salt);
        else if (which == 2) registry.reveal(id, dir, tp, sl - 1, salt);
        else registry.reveal(id, dir, tp, sl, ~salt);
    }

    function testFuzz_closeScoreBounds(uint16 tp, uint16 sl, int32 score) public {
        tp = uint16(bound(tp, 1, 3000));
        sl = uint16(bound(sl, 1, 1500));
        bytes32 h = _hash(alice, BTC, 1, tp, sl, 3600, SALT);
        vm.prank(alice);
        uint256 id = registry.commit(BTC, h, 3600);
        registry.reveal(id, 1, tp, sl, SALT);
        vm.prank(address(settlerV1));
        if (score < -int32(uint32(sl)) || score > int32(uint32(tp))) {
            vm.expectRevert();
            registry.close(id, score, 0);
        } else {
            registry.close(id, score, 0);
            assertEq(registry.getCall(id).scoreBps, score);
        }
    }
}
