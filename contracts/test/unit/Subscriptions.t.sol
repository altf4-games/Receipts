// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "../Base.t.sol";
import {Subscriptions, ICuratorBondedSubs} from "../../src/Subscriptions.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract SubscriptionsTest is Base {
    Subscriptions internal subs;
    address internal carol = makeAddr("carol"); // subscriber
    address internal dave = makeAddr("dave"); // third-party payer
    uint128 internal constant RATE = 1_000; // 0.001 AUSD per second

    function setUp() public override {
        super.setUp();
        subs = new Subscriptions(IERC20(address(token)), ICuratorBondedSubs(address(curators)));
        vm.prank(alice);
        subs.setRate(RATE);
        for (uint256 i = 0; i < 2; i++) {
            address who = i == 0 ? carol : dave;
            token.mint(who, 1_000e6);
            vm.prank(who);
            token.approve(address(subs), type(uint256).max);
        }
    }

    function _sub(uint256 amount) internal {
        vm.prank(carol);
        subs.subscribe(alice, amount);
    }

    // ---- rate
    function test_setRate_requiresBondedCurator() public {
        vm.prank(bob);
        vm.expectRevert(Subscriptions.NotBondedCurator.selector);
        subs.setRate(1);
    }

    function test_setRate_capped() public {
        uint128 tooHigh = subs.MAX_RATE() + 1; // read first: an external call would consume the prank
        vm.prank(alice);
        vm.expectRevert(Subscriptions.RateTooHigh.selector);
        subs.setRate(tooHigh);
    }

    function test_subscribe_revertsWhenCuratorNotAccepting() public {
        vm.prank(alice);
        subs.setRate(0);
        vm.prank(carol);
        vm.expectRevert(Subscriptions.NotAccepting.selector);
        subs.subscribe(alice, 1e6);
    }

    function test_subscribe_revertsForUnregisteredCurator() public {
        vm.prank(carol);
        vm.expectRevert(Subscriptions.NotBondedCurator.selector);
        subs.subscribe(bob, 1e6);
    }

    function test_subscribe_revertsBelowOneSecond() public {
        vm.prank(carol);
        vm.expectRevert(abi.encodeWithSelector(Subscriptions.AmountTooSmall.selector, uint256(RATE - 1), uint256(RATE)));
        subs.subscribe(alice, RATE - 1);
    }

    // ---- isActive transitions
    function test_isActive_transitions() public {
        assertFalse(subs.isActive(carol, alice));
        _sub(100 * RATE); // 100 seconds
        assertTrue(subs.isActive(carol, alice));
        assertEq(subs.activeUntil(carol, alice), uint64(block.timestamp + 100));
        vm.warp(block.timestamp + 99);
        assertTrue(subs.isActive(carol, alice));
        vm.warp(block.timestamp + 1);
        assertFalse(subs.isActive(carol, alice));
    }

    function test_isActive_partialSecondStillActiveUntilCeil() public {
        _sub(100 * RATE + 1); // 100.001 s: second 100 still has one unit left
        assertEq(subs.activeUntil(carol, alice), uint64(block.timestamp + 101)); // ceil, not floor
        vm.warp(block.timestamp + 100);
        assertTrue(subs.isActive(carol, alice));
        vm.warp(block.timestamp + 1);
        assertFalse(subs.isActive(carol, alice));
        assertEq(subs.accrued(carol, alice), 100 * RATE + 1);
    }

    // ---- exact refund (A15)
    function test_cancel_refundsExactlyTheUnaccrued() public {
        _sub(1_000 * RATE);
        vm.warp(block.timestamp + 250);
        uint256 balBefore = token.balanceOf(carol);
        vm.prank(carol);
        uint256 refund = subs.cancel(alice);
        assertEq(refund, 750 * RATE);
        assertEq(token.balanceOf(carol) - balBefore, 750 * RATE);
        assertEq(subs.owed(alice), 250 * RATE);
        assertFalse(subs.isActive(carol, alice));
        // curator can withdraw exactly the accrued part, nothing is left in the contract
        vm.prank(alice);
        assertEq(subs.claim(new address[](0)), 250 * RATE);
        assertEq(token.balanceOf(address(subs)), 0);
    }

    function test_cancel_sameSecondRefundsEverything() public {
        _sub(1_000 * RATE);
        vm.prank(carol);
        assertEq(subs.cancel(alice), 1_000 * RATE);
        assertEq(token.balanceOf(address(subs)), 0);
    }

    function test_cancel_afterExpiryRefundsNothingAndPaysCurator() public {
        _sub(10 * RATE);
        vm.warp(block.timestamp + 1 days);
        vm.prank(carol);
        assertEq(subs.cancel(alice), 0);
        assertEq(subs.owed(alice), 10 * RATE);
    }

    function test_cancel_noStreamReverts() public {
        vm.prank(carol);
        vm.expectRevert(Subscriptions.NoStream.selector);
        subs.cancel(alice);
    }

    function test_cancel_twiceReverts() public {
        _sub(10 * RATE);
        vm.startPrank(carol);
        subs.cancel(alice);
        vm.expectRevert(Subscriptions.NoStream.selector);
        subs.cancel(alice);
        vm.stopPrank();
    }

    // ---- claim
    function test_claim_pullsAccruedAcrossStreams() public {
        _sub(1_000 * RATE);
        vm.prank(dave);
        subs.subscribe(alice, 500 * RATE);
        vm.warp(block.timestamp + 100);
        address[] memory list = new address[](2);
        list[0] = carol;
        list[1] = dave;
        assertEq(subs.claimable(alice, list), 200 * RATE);
        uint256 aliceBefore = token.balanceOf(alice);
        vm.prank(alice);
        assertEq(subs.claim(list), 200 * RATE);
        assertEq(token.balanceOf(alice) - aliceBefore, 200 * RATE);
        // claiming again the same second pays nothing more
        vm.prank(alice);
        assertEq(subs.claim(list), 0);
        // later, only the newly accrued part
        vm.warp(block.timestamp + 50);
        vm.prank(alice);
        assertEq(subs.claim(list), 100 * RATE);
    }

    function test_claim_cannotTakeSomeoneElsesStream() public {
        _sub(1_000 * RATE);
        vm.warp(block.timestamp + 100);
        address[] memory list = new address[](1);
        list[0] = carol;
        vm.prank(bob); // bob has no streams under his own address
        assertEq(subs.claim(list), 0);
        assertEq(token.balanceOf(address(subs)), 1_000 * RATE);
    }

    function test_claim_cappedAtDepositAfterExpiry() public {
        _sub(10 * RATE);
        vm.warp(block.timestamp + 365 days);
        address[] memory list = new address[](1);
        list[0] = carol;
        vm.prank(alice);
        assertEq(subs.claim(list), 10 * RATE);
        assertEq(token.balanceOf(address(subs)), 0);
    }

    // ---- top up, rate change
    function test_topUp_whileActiveKeepsRateAndExtends() public {
        _sub(100 * RATE);
        uint64 start = uint64(block.timestamp);
        vm.warp(block.timestamp + 40);
        vm.prank(alice);
        subs.setRate(RATE * 10); // price rises for new streams only
        _sub(100 * RATE);
        Subscriptions.Stream memory s = subs.getStream(alice, carol);
        assertEq(s.rate, RATE);
        assertEq(s.start, start);
        assertEq(subs.activeUntil(carol, alice), start + 200);
        vm.warp(start + 199);
        assertTrue(subs.isActive(carol, alice));
        vm.warp(start + 200);
        assertFalse(subs.isActive(carol, alice));
    }

    function test_topUp_worksEvenIfCuratorStoppedAcceptingOrRaisedPrice() public {
        _sub(100 * RATE);
        vm.prank(alice);
        subs.setRate(0); // closed to new subscribers
        vm.prank(carol);
        subs.subscribe(alice, RATE); // a running stream can still be topped up by one second at ITS rate
        assertEq(subs.getStream(alice, carol).deposit, 101 * RATE);
        vm.prank(alice);
        subs.setRate(RATE * 50);
        vm.prank(carol);
        subs.subscribe(alice, RATE); // below the new price, still fine: the running stream's rate applies
        assertEq(subs.getStream(alice, carol).deposit, 102 * RATE);
    }

    function test_rateChange_doesNotTouchRunningStream() public {
        _sub(100 * RATE);
        vm.prank(alice);
        subs.setRate(RATE * 1000);
        vm.warp(block.timestamp + 10);
        assertEq(subs.accrued(carol, alice), 10 * RATE);
    }

    function test_resubscribeAfterExpiry_usesNewRateAndBanksOldEarnings() public {
        _sub(10 * RATE);
        vm.warp(block.timestamp + 100);
        vm.prank(alice);
        subs.setRate(RATE * 2);
        _sub(10 * RATE * 2);
        assertEq(subs.owed(alice), 10 * RATE); // old stream banked
        Subscriptions.Stream memory s = subs.getStream(alice, carol);
        assertEq(s.rate, RATE * 2);
        assertEq(s.claimed, 0);
        assertTrue(subs.isActive(carol, alice));
        vm.warp(block.timestamp + 10);
        assertFalse(subs.isActive(carol, alice));
        vm.prank(carol);
        assertEq(subs.cancel(alice), 0);
        vm.prank(alice);
        assertEq(subs.claim(new address[](0)), 10 * RATE + 20 * RATE);
        assertEq(token.balanceOf(address(subs)), 0);
    }

    // ---- subscribeFor
    function test_subscribeFor_payerPaysBeneficiaryOwns() public {
        uint256 payerBefore = token.balanceOf(dave);
        vm.prank(dave);
        subs.subscribeFor(carol, alice, 100 * RATE);
        assertEq(payerBefore - token.balanceOf(dave), 100 * RATE);
        assertTrue(subs.isActive(carol, alice));
        assertFalse(subs.isActive(dave, alice));
        // the payer cannot cancel it, the beneficiary can and the refund goes to the beneficiary
        vm.prank(dave);
        vm.expectRevert(Subscriptions.NoStream.selector);
        subs.cancel(alice);
        uint256 cBefore = token.balanceOf(carol);
        vm.prank(carol);
        subs.cancel(alice);
        assertEq(token.balanceOf(carol) - cBefore, 100 * RATE);
    }

    function test_subscribeFor_zeroBeneficiaryReverts() public {
        vm.prank(dave);
        vm.expectRevert(Subscriptions.ZeroAddress.selector);
        subs.subscribeFor(address(0), alice, 100 * RATE);
    }

    function test_subscribe_needsAllowance() public {
        address erin = makeAddr("erin");
        token.mint(erin, 1e6);
        vm.prank(erin);
        vm.expectRevert();
        subs.subscribe(alice, 1e6);
    }

    // ---- fuzz: no rounding loss, no value created or destroyed (A15)
    function testFuzz_conservation(uint128 rate, uint96 amount, uint32 waitSecs, uint32 waitMore) public {
        rate = uint128(bound(rate, 1, 1_000_000));
        amount = uint96(bound(amount, rate, 500e6));
        vm.prank(alice);
        subs.setRate(rate);
        token.mint(carol, amount);
        uint256 before = token.balanceOf(carol);
        vm.prank(carol);
        subs.subscribe(alice, amount);
        vm.warp(block.timestamp + uint256(waitSecs) % 30 days);
        uint256 expectAccrued = uint256(rate) * (uint256(waitSecs) % 30 days);
        if (expectAccrued > amount) expectAccrued = amount;
        assertEq(subs.accrued(carol, alice), expectAccrued);
        assertEq(subs.refundable(carol, alice), amount - expectAccrued);
        assertEq(subs.isActive(carol, alice), expectAccrued < amount);

        vm.warp(block.timestamp + uint256(waitMore) % 30 days);
        uint256 finalAccrued = uint256(rate) * ((uint256(waitSecs) % 30 days) + (uint256(waitMore) % 30 days));
        if (finalAccrued > amount) finalAccrued = amount;
        vm.prank(carol);
        uint256 refund = subs.cancel(alice);
        assertEq(refund, amount - finalAccrued);
        vm.prank(alice);
        uint256 paid = subs.claim(new address[](0));
        assertEq(paid, finalAccrued);
        assertEq(paid + refund, amount);
        assertEq(token.balanceOf(address(subs)), 0);
        assertEq(before - token.balanceOf(carol) + refund, amount); // net spend == what curator got
    }

    // ---- fuzz: claiming in pieces never pays more than the stream's total
    function testFuzz_claimInPiecesSumsToAccrued(uint128 rate, uint96 amount, uint16 a, uint16 b, uint16 c) public {
        rate = uint128(bound(rate, 1, 1_000_000));
        amount = uint96(bound(amount, rate, 500e6));
        vm.prank(alice);
        subs.setRate(rate);
        token.mint(carol, amount);
        vm.prank(carol);
        subs.subscribe(alice, amount);
        address[] memory list = new address[](1);
        list[0] = carol;
        uint256 total;
        uint256[3] memory steps = [uint256(a), uint256(b), uint256(c)];
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + steps[i]);
            vm.prank(alice);
            total += subs.claim(list);
        }
        assertEq(total, subs.accrued(carol, alice));
        vm.prank(carol);
        uint256 refund = subs.cancel(alice);
        vm.prank(alice);
        total += subs.claim(new address[](0));
        assertEq(total + refund, amount);
    }
}
