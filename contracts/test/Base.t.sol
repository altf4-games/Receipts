// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {CuratorRegistry} from "../src/CuratorRegistry.sol";
import {CallRegistry, ICuratorBonded} from "../src/CallRegistry.sol";
import {SettlerV1} from "../src/SettlerV1.sol";
import {IPerplExchange} from "../src/interfaces/IPerplExchange.sol";
import {MockPerplExchange} from "./mocks/MockPerplExchange.sol";
import {MockToken} from "./mocks/MockToken.sol";

abstract contract Base is Test {
    uint256 internal constant MIN_BOND = 50e6;
    uint32 internal constant MIN_HORIZON = 900;
    uint32 internal constant MAX_ORACLE_AGE = 120;
    uint32 internal constant SETTLER_DELAY = 1 days;
    uint256 internal constant BTC = 16;
    uint256 internal constant ETH = 32;

    address internal owner = makeAddr("owner");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal keeper = makeAddr("keeper");

    MockToken internal token;
    MockPerplExchange internal ex;
    CuratorRegistry internal curators;
    CallRegistry internal registry;
    SettlerV1 internal settlerV1;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        token = new MockToken();
        ex = new MockPerplExchange();
        ex.setOracle(BTC, 849_810, block.timestamp, 1);
        ex.setOracle(ETH, 269_510, block.timestamp, 2);

        curators = new CuratorRegistry(owner, token, MIN_BOND);
        // registry needs its settler at construction: predict the address (registry = nonce n, settler = n+1)
        address predictedSettler = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        registry = new CallRegistry(
            owner,
            ICuratorBonded(address(curators)),
            IPerplExchange(address(ex)),
            predictedSettler,
            MIN_HORIZON,
            MAX_ORACLE_AGE,
            SETTLER_DELAY
        );
        settlerV1 = new SettlerV1(registry, IPerplExchange(address(ex)), MAX_ORACLE_AGE);
        assertEq(address(settlerV1), predictedSettler);
        vm.startPrank(owner);
        curators.setCallRegistry(address(registry));
        registry.setMarketAllowed(BTC, true);
        registry.setMarketAllowed(ETH, true);
        vm.stopPrank();

        _register(alice, "alice", false);
    }

    function _register(address who, string memory handle, bool isBot) internal {
        token.mint(who, 1_000e6);
        vm.startPrank(who);
        token.approve(address(curators), type(uint256).max);
        curators.register(handle, "ipfs://meta", isBot, MIN_BOND);
        vm.stopPrank();
    }

    function _hash(address who, uint256 perp, uint8 dir, uint16 tp, uint16 sl, uint32 h, bytes32 salt)
        internal
        view
        returns (bytes32)
    {
        return registry.hashCall(who, perp, dir, tp, sl, h, salt);
    }

    /// @dev commit a valid long BTC call 1h horizon by `who`; returns id.
    function _commitLong(address who, uint256 perp, uint16 tp, uint16 sl, bytes32 salt) internal returns (uint256 id) {
        bytes32 h = _hash(who, perp, 1, tp, sl, 3600, salt);
        vm.prank(who);
        id = registry.commit(perp, h, 3600);
    }

    function _setPrice(uint256 perp, uint256 price) internal {
        ex.setOracle(perp, price, block.timestamp, perp == BTC ? 1 : 2);
    }
}
