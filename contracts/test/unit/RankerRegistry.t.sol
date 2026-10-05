// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {RankerRegistry} from "../../src/RankerRegistry.sol";

contract RankerRegistryTest is Test {
    RankerRegistry internal reg;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    bytes20 internal constant COMMIT = bytes20(hex"0123456789abcdef0123456789abcdef01234567");

    function setUp() public {
        reg = new RankerRegistry();
    }

    function test_register_storesEverythingAndEmits() public {
        vm.expectEmit(true, true, false, true);
        emit RankerRegistry.RankerRegistered(1, alice, "luck-adjusted", "https://example.com/c/abc", COMMIT);
        vm.prank(alice);
        uint256 id = reg.register("luck-adjusted", "https://example.com/c/abc", COMMIT);
        assertEq(id, 1);
        assertEq(reg.rankerCount(), 1);
        RankerRegistry.Ranker memory r = reg.getRanker(1);
        assertEq(r.author, alice);
        assertEq(r.name, "luck-adjusted");
        assertEq(r.codeURI, "https://example.com/c/abc");
        assertEq(r.gitCommit, COMMIT);
        assertEq(r.registeredAt, uint64(block.timestamp));
        assertEq(reg.idByName(keccak256("luck-adjusted")), 1);
    }

    function test_register_rejectsEmptyOrOversizedFieldsAndZeroCommit() public {
        vm.expectRevert(RankerRegistry.InvalidName.selector);
        reg.register("", "uri", COMMIT);
        vm.expectRevert(RankerRegistry.InvalidName.selector);
        reg.register(string(new bytes(65)), "uri", COMMIT);
        vm.expectRevert(RankerRegistry.InvalidURI.selector);
        reg.register("n", "", COMMIT);
        vm.expectRevert(RankerRegistry.InvalidURI.selector);
        reg.register("n", string(new bytes(257)), COMMIT);
        vm.expectRevert(RankerRegistry.ZeroCommit.selector);
        reg.register("n", "uri", bytes20(0));
        // boundary lengths are accepted
        reg.register(string(new bytes(64)), string(new bytes(256)), COMMIT);
    }

    function test_register_duplicateNameReverts_butSameCodeUnderAnotherNameIsFine() public {
        reg.register("raw", "uri", COMMIT);
        vm.expectRevert(abi.encodeWithSelector(RankerRegistry.NameTaken.selector, uint256(1)));
        vm.prank(bob);
        reg.register("raw", "uri2", COMMIT);
        vm.prank(bob);
        assertEq(reg.register("raw-v2", "uri", COMMIT), 2);
    }

    function test_getRanker_unknownReverts() public {
        vm.expectRevert(abi.encodeWithSelector(RankerRegistry.UnknownRanker.selector, uint256(0)));
        reg.getRanker(0);
        vm.expectRevert(abi.encodeWithSelector(RankerRegistry.UnknownRanker.selector, uint256(1)));
        reg.getRanker(1);
    }

    function test_publishRanking_onlyAuthor_andNotFromTheFuture() public {
        vm.prank(alice);
        reg.register("raw", "uri", COMMIT);
        vm.expectEmit(true, true, false, true);
        emit RankerRegistry.RankingPublished(1, bytes32(uint256(7)), uint64(block.number), alice);
        vm.prank(alice);
        reg.publishRanking(1, bytes32(uint256(7)), uint64(block.number));
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(RankerRegistry.NotAuthor.selector, bob, alice));
        reg.publishRanking(1, bytes32(uint256(7)), 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(RankerRegistry.FutureBlock.selector, uint64(block.number + 1)));
        reg.publishRanking(1, bytes32(uint256(7)), uint64(block.number + 1));
        vm.expectRevert(abi.encodeWithSelector(RankerRegistry.UnknownRanker.selector, uint256(9)));
        reg.publishRanking(9, bytes32(0), 1);
    }
}
