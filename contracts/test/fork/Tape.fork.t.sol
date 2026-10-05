// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceTape} from "../../src/PriceTape.sol";
import {IPerplExchange} from "../../src/interfaces/IPerplExchange.sol";

/// @notice FORK test: the PriceTape against the REAL Perpl Exchange on Monad testnet. No mocks.
///         set -a; . ../.env; set +a; forge test --match-path 'test/fork/Tape.fork.t.sol' --fork-url $MONAD_TESTNET_RPC
contract TapeForkTest is Test {
    IPerplExchange internal constant EXCHANGE = IPerplExchange(0x1964C32f0bE608E7D29302AFF5E61268E72080cc);
    address internal forwarder = makeAddr("forwarder");

    function test_tapeRecordsTheRealOraclePriceForEveryAllowlistedMarket() public {
        PriceTape tape = new PriceTape(EXCHANGE, 120, forwarder);
        uint256[] memory ids = new uint256[](5);
        ids[0] = 16; ids[1] = 32; ids[2] = 48; ids[3] = 64; ids[4] = 256; // BTC ETH SOL MON ZEC (Perpl testnet ids)
        uint256 n = tape.sample(ids);
        assertEq(n, 5);
        for (uint256 i = 0; i < ids.length; i++) {
            IPerplExchange.PerpetualInfo memory info = EXCHANGE.getPerpetualInfo(ids[i]);
            PriceTape.Sample memory s = tape.sampleAt(ids[i], 0);
            assertEq(uint256(s.price), info.oraclePNS, "tape price == Exchange oraclePNS");
            assertEq(uint256(s.ts), info.oracleTimestampSec, "tape ts == Exchange oracle ts");
            assertEq(uint256(tape.decimalsOf(ids[i])), info.priceDecimals);
            assertGt(s.price, 0);
        }
        // sampling again in the same block adds nothing (same oracle timestamp)
        assertEq(tape.sample(ids), 0);
    }

    function test_unknownMarketReverts() public {
        PriceTape tape = new PriceTape(EXCHANGE, 120, forwarder);
        uint256[] memory ids = new uint256[](1);
        ids[0] = 999_999;
        vm.expectRevert();
        tape.sample(ids);
    }
}
