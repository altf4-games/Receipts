// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "../Base.t.sol";
import {PriceTape} from "../../src/PriceTape.sol";
import {PerplOracleLib} from "../../src/libraries/PerplOracleLib.sol";
import {IPerplExchange} from "../../src/interfaces/IPerplExchange.sol";
import {IReceiver} from "../../src/interfaces/IReceiver.sol";

contract PriceTapeTest is Base {
    PriceTape internal tape;
    address internal forwarder = makeAddr("forwarder");
    address internal stranger = makeAddr("stranger");

    function setUp() public override {
        super.setUp();
        tape = new PriceTape(IPerplExchange(address(ex)), MAX_ORACLE_AGE, forwarder);
    }

    function _push(uint256 perp, uint256 price, uint256 ts) internal returns (uint256 appended) {
        vm.warp(ts);
        ex.setOracle(perp, price, ts, perp == BTC ? 1 : 2);
        uint256[] memory ids = new uint256[](1);
        ids[0] = perp;
        appended = tape.sample(ids);
    }

    function test_sample_appendsOnlyNewerOracleTimestamps() public {
        uint256 t = block.timestamp;
        assertEq(_push(BTC, 849_810, t), 1);
        assertEq(tape.sampleCount(BTC), 1);
        // same oracle timestamp again: nothing new, even if called again in a later block
        vm.warp(t + 10);
        uint256[] memory ids = new uint256[](1);
        ids[0] = BTC;
        assertEq(tape.sample(ids), 0);
        assertEq(tape.sampleCount(BTC), 1);
        // an OLDER oracle timestamp than the last sample is ignored too (cannot rewrite history)
        ex.setOracle(BTC, 700_000, t - 5, 1);
        assertEq(tape.sample(ids), 0);
        assertEq(_push(BTC, 850_000, t + 20), 1);
        PriceTape.Sample memory s = tape.sampleAt(BTC, 1);
        assertEq(s.price, 850_000);
        assertEq(s.ts, t + 20);
        assertEq(s.blockNumber, block.number);
        assertEq(tape.decimalsOf(BTC), 1);
    }

    function test_sample_isPermissionless_andBatchedAcrossMarkets() public {
        uint256 t = block.timestamp;
        ex.setOracle(BTC, 849_810, t, 1);
        ex.setOracle(ETH, 269_510, t, 2);
        uint256[] memory ids = new uint256[](2);
        ids[0] = BTC;
        ids[1] = ETH;
        vm.prank(stranger);
        assertEq(tape.sample(ids), 2);
        assertEq(tape.sampleCount(ETH), 1);
        assertEq(tape.decimalsOf(ETH), 2);
    }

    function test_sample_unknownMarketAndStaleOracleRevert() public {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 999;
        vm.expectRevert();
        tape.sample(ids);
        ex.setOracle(BTC, 849_810, block.timestamp - 1000, 1);
        ids[0] = BTC;
        vm.expectRevert();
        tape.sample(ids);
    }

    function test_sample_decimalsChangeRevertsInsteadOfMixingScales() public {
        uint256 t = block.timestamp;
        _push(BTC, 849_810, t);
        vm.warp(t + 60);
        ex.setOracle(BTC, 8_498_100, t + 60, 2);
        uint256[] memory ids = new uint256[](1);
        ids[0] = BTC;
        vm.expectRevert(abi.encodeWithSelector(PriceTape.PriceDecimalsChanged.selector, BTC, uint8(1), uint8(2)));
        tape.sample(ids);
    }

    function test_firstIndexAtOrAfter_binarySearch() public {
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < 10; i++) _push(BTC, 849_810 + i, t + i * 50);
        assertEq(tape.firstIndexAtOrAfter(BTC, uint64(t)), 0);
        assertEq(tape.firstIndexAtOrAfter(BTC, uint64(t + 1)), 1);
        assertEq(tape.firstIndexAtOrAfter(BTC, uint64(t + 50)), 1);
        assertEq(tape.firstIndexAtOrAfter(BTC, uint64(t + 450)), 9);
        assertEq(tape.firstIndexAtOrAfter(BTC, uint64(t + 451)), 10); // none: returns the count
        assertEq(tape.firstIndexAtOrAfter(ETH, 1), 0); // empty tape
    }

    // ---- CRE report path
    function test_onReport_onlyForwarder() public {
        bytes memory report = abi.encode(new uint256[](0), new uint128[](0));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(PriceTape.NotForwarder.selector, stranger));
        tape.onReport("", report);
    }

    function test_onReport_samplesTheRealOracle_andIgnoresAForgedPrice() public {
        uint256 t = block.timestamp;
        ex.setOracle(BTC, 849_810, t, 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = BTC;
        uint128[] memory rest = new uint128[](1);
        rest[0] = 1_000_000_000_000; // a forged / absurd REST price
        vm.prank(forwarder);
        tape.onReport("", abi.encode(ids, rest));
        // the tape holds the ORACLE price, not the report's
        assertEq(tape.sampleAt(BTC, 0).price, 849_810);
    }

    function test_onReport_emitsCrossCheckWithDivergence() public {
        uint256 t = block.timestamp;
        ex.setOracle(BTC, 100_000, t, 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = BTC;
        uint128[] memory rest = new uint128[](1);
        rest[0] = 100_500; // +0.5% => 50 bps
        vm.expectEmit(true, false, false, true);
        emit PriceTape.CrossCheck(BTC, 100_000, 100_500, 50);
        vm.prank(forwarder);
        tape.onReport("", abi.encode(ids, rest));
        // REST unavailable (0) => divergence 0, still samples
        vm.warp(t + 60);
        ex.setOracle(BTC, 100_100, t + 60, 1);
        rest[0] = 0;
        vm.expectEmit(true, false, false, true);
        emit PriceTape.CrossCheck(BTC, 100_100, 0, 0);
        vm.prank(forwarder);
        tape.onReport("", abi.encode(ids, rest));
        assertEq(tape.sampleCount(BTC), 2);
    }

    function test_onReport_unchangedOracleStillEmitsCheckButNoNewSample() public {
        uint256 t = block.timestamp;
        ex.setOracle(BTC, 100_000, t, 1);
        uint256[] memory ids = new uint256[](1);
        ids[0] = BTC;
        uint128[] memory rest = new uint128[](1);
        rest[0] = 100_000;
        vm.startPrank(forwarder);
        tape.onReport("", abi.encode(ids, rest));
        tape.onReport("", abi.encode(ids, rest));
        vm.stopPrank();
        assertEq(tape.sampleCount(BTC), 1);
    }

    function test_onReport_lengthMismatchReverts() public {
        vm.prank(forwarder);
        vm.expectRevert(PriceTape.BadReport.selector);
        tape.onReport("", abi.encode(new uint256[](1), new uint128[](0)));
    }

    function test_supportsReceiverInterface() public view {
        assertTrue(tape.supportsInterface(type(IReceiver).interfaceId));
        assertTrue(tape.supportsInterface(0x01ffc9a7)); // ERC165
        assertFalse(tape.supportsInterface(0xffffffff));
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(PriceTape.ZeroAddress.selector);
        new PriceTape(IPerplExchange(address(0)), MAX_ORACLE_AGE, forwarder);
        vm.expectRevert(PriceTape.ZeroAddress.selector);
        new PriceTape(IPerplExchange(address(ex)), MAX_ORACLE_AGE, address(0));
    }

    function testFuzz_tapeIsStrictlyIncreasingInTime(uint8 n, uint16 seed) public {
        uint256 count = bound(n, 1, 30);
        uint256 t = block.timestamp;
        for (uint256 i = 0; i < count; i++) {
            // random forward steps (sometimes 0 = no new sample, sometimes backwards = ignored)
            uint256 step = uint256(keccak256(abi.encode(seed, i))) % 100;
            uint256 ts = t + step;
            vm.warp(t + 100);
            ex.setOracle(BTC, 849_810 + i, ts, 1);
            uint256[] memory ids = new uint256[](1);
            ids[0] = BTC;
            tape.sample(ids);
            t += 100;
            vm.warp(t);
        }
        uint256 c = tape.sampleCount(BTC);
        for (uint256 i = 1; i < c; i++) assertGt(tape.sampleAt(BTC, i).ts, tape.sampleAt(BTC, i - 1).ts);
    }
}
