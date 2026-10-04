// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {CuratorRegistry} from "../../src/CuratorRegistry.sol";
import {CallRegistry, ICuratorBonded} from "../../src/CallRegistry.sol";
import {SettlerV1} from "../../src/SettlerV1.sol";
import {IPerplExchange} from "../../src/interfaces/IPerplExchange.sol";
import {PerplOracleLib} from "../../src/libraries/PerplOracleLib.sol";

/// @notice FORK tests: real Perpl Exchange + real Agora AUSD on Monad testnet (chain 10143).
///         No mocks. Run:  set -a; . ../.env; set +a; forge test --match-path 'test/fork/*' -vv
///         Needs MONAD_TESTNET_RPC (fails loudly when missing; a skipped fork test would be a lie).
contract ForkTest is Test {
    address internal constant EXCHANGE = 0x1964C32f0bE608E7D29302AFF5E61268E72080cc;
    address internal constant AUSD = 0xa9012a055bd4e0eDfF8Ce09f960291C09D5322dC;
    address internal constant FAUCET = 0xd236c18D274E54FAccC3dd9DDA4b27965a73ee6C;
    bytes4 internal constant CONTRACT_DOES_NOT_EXIST = 0x4c9f9b4a;

    uint256 internal constant BTC = 16;
    uint256 internal constant MIN_BOND = 50e6;
    uint32 internal constant HORIZON = 60;
    uint32 internal constant MAX_AGE = 120;
    bytes32 internal constant SALT = bytes32(uint256(0xFEED));

    address internal owner = makeAddr("owner");
    address internal curator = makeAddr("curator");

    CuratorRegistry internal curators;
    CallRegistry internal registry;
    SettlerV1 internal settler;
    string internal rpc;

    function setUp() public {
        rpc = vm.envString("MONAD_TESTNET_RPC");
    }

    // ---------------------------------------------------------------- helpers

    /// @dev Fork at `blockNumber`, deploy a fresh system wired to the REAL exchange and REAL AUSD.
    function _deployAt(uint256 blockNumber) internal {
        vm.createSelectFork(rpc, blockNumber);
        curators = new CuratorRegistry(owner, IERC20(AUSD), MIN_BOND);
        address predicted = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        registry = new CallRegistry(
            owner, ICuratorBonded(address(curators)), IPerplExchange(EXCHANGE), predicted, HORIZON, MAX_AGE, 1 days
        );
        settler = new SettlerV1(registry, IPerplExchange(EXCHANGE), MAX_AGE);
        require(address(settler) == predicted, "settler prediction");
        vm.startPrank(owner);
        curators.setCallRegistry(address(registry));
        for (uint256 i = 0; i < 5; i++) registry.setMarketAllowed(_markets()[i], true);
        vm.stopPrank();

        // Fund the bond from the REAL Agora testnet faucet (10,000 AUSD per call). `deal` cannot find AUSD's
        // balance slot (proxy), and a faucet call is the honest path anyway.
        IFaucet(FAUCET).requestFunds(curator);
        assertGe(IERC20(AUSD).balanceOf(curator), MIN_BOND, "faucet did not fund the curator");
        vm.startPrank(curator);
        IERC20(AUSD).approve(address(curators), type(uint256).max);
        curators.register("fork-curator", "", false, MIN_BOND);
        vm.stopPrank();

        // Keep our contracts alive across vm.rollFork.
        vm.makePersistent(address(curators), address(registry), address(settler));
        vm.makePersistent(curator, owner);
    }

    function _markets() internal pure returns (uint256[5] memory m) {
        m = [uint256(16), 32, 48, 64, 256];
    }

    /// @dev Independent decode of oraclePNS / oracleTimestampSec straight from the raw return bytes.
    ///      Layout: [0x20 outer offset][struct head: 30 words]. oraclePNS = head word 15, oracleTs = word 16.
    function _rawOracle(uint256 perpId) internal view returns (uint256 price, uint256 ts, uint256 decimals) {
        (bool ok, bytes memory ret) = EXCHANGE.staticcall(abi.encodeWithSelector(0x00092cce, perpId));
        require(ok, "raw getPerpetualInfo failed");
        uint256 base = 32; // skip outer offset word
        assembly {
            decimals := mload(add(add(ret, 32), add(base, mul(2, 32)))) // head word 2 = priceDecimals
            price := mload(add(add(ret, 32), add(base, mul(15, 32))))
            ts := mload(add(add(ret, 32), add(base, mul(16, 32))))
        }
    }

    function _latestBlock() internal returns (uint256) {
        vm.createSelectFork(rpc);
        return block.number;
    }

    // ---------------------------------------------------------------- oracle library vs the real Exchange

    function test_fork_oracleLib_matchesIndependentRawDecode_onAllAllowlistedMarkets() public {
        vm.createSelectFork(rpc);
        uint256[5] memory m = _markets();
        uint256[5] memory dec = [uint256(1), 2, 2, 5, 3];
        for (uint256 i = 0; i < 5; i++) {
            (uint256 rawPrice, uint256 rawTs, uint256 rawDec) = _rawOracle(m[i]);
            PerplOracleLib.Snapshot memory s = _snap(m[i]);
            assertEq(uint256(s.price), rawPrice, "price differs from raw decode");
            assertEq(uint256(s.oracleTs), rawTs, "oracle ts differs from raw decode");
            assertEq(uint256(s.priceDecimals), rawDec);
            assertEq(rawDec, dec[i], "decimals differ from REST /pub/context");
            assertGt(rawPrice, 0);
            emit log_named_uint(string.concat("perp ", vm.toString(m[i]), " oraclePNS"), rawPrice);
        }
    }

    function _snap(uint256 perpId) internal view returns (PerplOracleLib.Snapshot memory) {
        return _SnapCaller.snap(IPerplExchange(EXCHANGE), perpId, MAX_AGE);
    }

    function test_fork_A8_unknownMarketsRevertOnTheRealExchange() public {
        vm.createSelectFork(rpc);
        (bool ok, bytes memory ret) = EXCHANGE.staticcall(abi.encodeWithSelector(0x00092cce, uint256(999)));
        assertFalse(ok);
        assertEq(bytes4(ret), CONTRACT_DOES_NOT_EXIST);
        (ok, ret) = EXCHANGE.staticcall(abi.encodeWithSelector(0x00092cce, uint256(0)));
        assertFalse(ok);
        assertEq(bytes4(ret), CONTRACT_DOES_NOT_EXIST);
    }

    function test_fork_A8_commitOnAllowlistedButUnknownMarket_bubblesExchangeRevert() public {
        _deployAt(_latestBlock() - 100);
        vm.prank(owner);
        registry.setMarketAllowed(999, true);
        bytes32 h = registry.hashCall(curator, 999, 1, 500, 300, HORIZON, SALT);
        vm.prank(curator);
        vm.expectRevert(abi.encodeWithSelector(CONTRACT_DOES_NOT_EXIST, uint256(999)));
        registry.commit(999, h, HORIZON);
    }

    // ---------------------------------------------------------------- A1 / A7 on real state

    function test_fork_A1_commitStoresExactlyTheRealOracleAtThatBlock() public {
        _deployAt(_latestBlock() - 100);
        bytes32 h = registry.hashCall(curator, BTC, 1, 500, 300, HORIZON, SALT);
        vm.prank(curator);
        uint256 id = registry.commit(BTC, h, HORIZON);

        (uint256 rawPrice, uint256 rawTs, uint256 rawDec) = _rawOracle(BTC);
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(uint256(c.entryPNS), rawPrice, "stored entry != oracle at this block");
        assertEq(uint256(c.entryOracleTs), rawTs);
        assertEq(uint256(c.priceDecimals), rawDec);
        assertEq(uint256(c.commitBlock), block.number);
        emit log_named_uint("block", block.number);
        emit log_named_uint("entryPNS", c.entryPNS);
    }

    function test_fork_A7_staleOracleRevertsOnRealData() public {
        _deployAt(_latestBlock() - 100);
        (, uint256 ts,) = _rawOracle(BTC);
        vm.warp(ts + MAX_AGE + 1); // the real oracle sample is now older than the allowed age
        bytes32 h = registry.hashCall(curator, BTC, 1, 500, 300, HORIZON, SALT);
        vm.prank(curator);
        vm.expectRevert(
            abi.encodeWithSelector(PerplOracleLib.OracleStale.selector, BTC, uint256(MAX_AGE) + 1, uint256(MAX_AGE))
        );
        registry.commit(BTC, h, HORIZON);
    }

    function test_fork_commitSucceedsOnEveryAllowlistedMarket() public {
        _deployAt(_latestBlock() - 100);
        uint256[5] memory m = _markets();
        for (uint256 i = 0; i < 5; i++) {
            bytes32 h = registry.hashCall(curator, m[i], 2, 400, 200, HORIZON, SALT);
            vm.prank(curator);
            uint256 id = registry.commit(m[i], h, HORIZON);
            (uint256 rawPrice,,) = _rawOracle(m[i]);
            assertEq(uint256(registry.getCall(id).entryPNS), rawPrice);
        }
        assertEq(registry.openCallCount(curator), 5);
    }

    // ---------------------------------------------------------------- full lifecycle across real historical blocks

    /// Commit at block N, settle at block N+800 (~4 min later). Exit price and expected score are recomputed
    /// from independent raw reads at both blocks.
    function test_fork_fullLifecycle_commitRevealSettle_scoreEqualsIndependentRecompute() public {
        uint256 n = _latestBlock() - 4000;
        _deployAt(n);

        bytes32 h = registry.hashCall(curator, BTC, 1, 500, 300, HORIZON, SALT);
        vm.prank(curator);
        uint256 id = registry.commit(BTC, h, HORIZON);
        (uint256 entryRaw,,) = _rawOracle(BTC);
        assertEq(uint256(registry.getCall(id).entryPNS), entryRaw);
        uint64 horizonEnd = registry.getCall(id).horizonEnd;

        registry.reveal(id, 1, 500, 300, SALT); // anyone, inside the window

        vm.rollFork(n + 800);
        assertGe(block.timestamp, horizonEnd);
        (uint256 exitRaw, uint256 exitTs,) = _rawOracle(BTC);
        assertGe(exitTs, horizonEnd, "test setup: exit oracle sample must be at/after the horizon");

        int256 raw = (int256(exitRaw) - int256(entryRaw)) * 10_000 / int256(entryRaw);
        int256 want = raw < -300 ? int256(-300) : (raw > 500 ? int256(500) : raw);

        int32 score = settler.settle(id);
        assertEq(int256(score), want, "onchain score != independent recompute from real oracle reads");
        CallRegistry.Call memory c = registry.getCall(id);
        assertEq(uint8(c.status), uint8(CallRegistry.Status.Settled));
        assertEq(c.scoreBps, score);
        assertEq(registry.openCallId(curator, BTC), 0);
        emit log_named_uint("entryPNS", entryRaw);
        emit log_named_uint("exitPNS", exitRaw);
        emit log_named_int("rawBps", raw);
        emit log_named_int("scoreBps", int256(score));
    }

    function test_fork_expirePath_realTimestamps() public {
        uint256 n = _latestBlock() - 4000;
        _deployAt(n);
        bytes32 h = registry.hashCall(curator, BTC, 1, 500, 300, HORIZON, SALT);
        vm.prank(curator);
        uint256 id = registry.commit(BTC, h, HORIZON);

        vm.expectRevert(); // cannot expire inside the window (real clock)
        registry.expire(id);

        vm.rollFork(n + 800);
        vm.expectRevert(abi.encodeWithSelector(CallRegistry.RevealWindowClosed.selector, registry.getCall(id).horizonEnd));
        registry.reveal(id, 1, 500, 300, SALT); // too late
        registry.expire(id);
        assertEq(registry.getCall(id).scoreBps, -3000);
        assertEq(registry.openCallCount(curator), 0);
    }

    function test_fork_settleBeforeHorizonReverts_onRealClock() public {
        _deployAt(_latestBlock() - 100);
        bytes32 h = registry.hashCall(curator, BTC, 1, 500, 300, HORIZON, SALT);
        vm.prank(curator);
        uint256 id = registry.commit(BTC, h, HORIZON);
        registry.reveal(id, 1, 500, 300, SALT);
        vm.expectRevert(abi.encodeWithSelector(SettlerV1.TooEarly.selector, registry.getCall(id).horizonEnd));
        settler.settle(id);
    }
}

interface IFaucet {
    function requestFunds(address to) external;
}

/// @dev Internal library functions cannot be pranked/called externally; wrap in a tiny contract.
library _SnapCaller {
    function snap(IPerplExchange ex, uint256 perpId, uint256 maxAge) internal view returns (PerplOracleLib.Snapshot memory) {
        return PerplOracleLib.snapshot(ex, perpId, maxAge);
    }
}
