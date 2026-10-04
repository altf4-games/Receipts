// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "../Base.t.sol";
import {CuratorRegistry} from "../../src/CuratorRegistry.sol";

contract CuratorRegistryTest is Base {
    function _sign(uint256 pk, address curator, uint256 nonce) internal view returns (bytes memory) {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n",
                _len(bytes(curators.identityMessage(curator, nonce)).length),
                curators.identityMessage(curator, nonce)
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _len(uint256 n) internal pure returns (string memory) {
        return vm.toString(n);
    }

    function test_register_pullsBond_andIsBonded() public view {
        assertTrue(curators.isBonded(alice));
        assertEq(token.balanceOf(address(curators)), MIN_BOND);
        CuratorRegistry.Curator memory c = curators.getCurator(alice);
        assertEq(c.handle, "alice");
        assertFalse(c.isBot);
        assertEq(c.bond, MIN_BOND);
    }

    function test_register_revertsBelowMinBond() public {
        token.mint(bob, 100e6);
        vm.startPrank(bob);
        token.approve(address(curators), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(CuratorRegistry.BondTooLow.selector, MIN_BOND - 1, MIN_BOND));
        curators.register("bobby", "", false, MIN_BOND - 1);
        vm.stopPrank();
    }

    function test_register_twiceReverts() public {
        vm.prank(alice);
        vm.expectRevert(CuratorRegistry.AlreadyRegistered.selector);
        curators.register("alice2", "", false, MIN_BOND);
    }

    function test_handle_rules() public {
        token.mint(bob, 1_000e6);
        vm.startPrank(bob);
        token.approve(address(curators), type(uint256).max);
        vm.expectRevert(CuratorRegistry.InvalidHandle.selector);
        curators.register("ab", "", false, MIN_BOND); // too short
        vm.expectRevert(CuratorRegistry.InvalidHandle.selector);
        curators.register("Bobby", "", false, MIN_BOND); // uppercase
        vm.expectRevert(CuratorRegistry.InvalidHandle.selector);
        curators.register("bob by", "", false, MIN_BOND); // space
        vm.expectRevert(CuratorRegistry.InvalidHandle.selector);
        curators.register("abcdefghijklmnopqrstuvwxyz0123456789", "", false, MIN_BOND); // 36 chars
        vm.stopPrank();
    }

    function test_handle_taken() public {
        token.mint(bob, 1_000e6);
        vm.startPrank(bob);
        token.approve(address(curators), type(uint256).max);
        vm.expectRevert(CuratorRegistry.HandleTaken.selector);
        curators.register("alice", "", false, MIN_BOND);
        vm.stopPrank();
    }

    function test_botLabel_cannotBeEvadedOrFaked() public {
        token.mint(bob, 1_000e6);
        vm.startPrank(bob);
        token.approve(address(curators), type(uint256).max);
        vm.expectRevert(CuratorRegistry.BotHandleMismatch.selector);
        curators.register("bot:sneaky", "", false, MIN_BOND); // bot-looking handle, claims human
        vm.expectRevert(CuratorRegistry.BotHandleMismatch.selector);
        curators.register("humanname", "", true, MIN_BOND); // declares bot without prefix
        curators.register("bot:ok", "", true, MIN_BOND);
        vm.stopPrank();
        assertTrue(curators.getCurator(bob).isBot);
    }

    function test_unbond_blocksCommit_cooldown_andOpenCalls() public {
        uint256 id = _commitLong(alice, BTC, 500, 300, bytes32(uint256(1)));

        vm.prank(alice);
        curators.requestUnbond();
        assertFalse(curators.isBonded(alice));

        // cannot commit new calls once unbonding
        bytes32 h = _hash(alice, ETH, 1, 500, 300, 3600, bytes32(uint256(2)));
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("NotBonded(address)")), alice));
        registry.commit(ETH, h, 3600);

        // cooldown
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(CuratorRegistry.CooldownActive.selector, uint64(block.timestamp) + 1 days)
        );
        curators.withdrawBond();

        // after cooldown, still has an open call
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(CuratorRegistry.OpenCallsRemain.selector, 1));
        curators.withdrawBond();

        // expire the call (never revealed) then withdraw
        vm.warp(block.timestamp + 3600 + 1);
        registry.expire(id);
        vm.prank(alice);
        curators.withdrawBond();
        assertEq(token.balanceOf(alice), 1_000e6);
        assertEq(token.balanceOf(address(curators)), 0);
        assertFalse(curators.isBonded(alice));
    }

    function test_withdraw_withoutUnbondReverts() public {
        vm.prank(alice);
        vm.expectRevert(CuratorRegistry.NotUnbonding.selector);
        curators.withdrawBond();
    }

    function test_addBond_whileUnbondingReverts_andNormalAddWorks() public {
        vm.startPrank(alice);
        curators.addBond(10e6);
        assertEq(curators.getCurator(alice).bond, MIN_BOND + 10e6);
        curators.requestUnbond();
        vm.expectRevert(CuratorRegistry.AlreadyUnbonding.selector);
        curators.addBond(1);
        vm.stopPrank();
    }

    function test_setCallRegistry_onlyOnceAndOnlyOwner() public {
        vm.prank(owner);
        vm.expectRevert(CuratorRegistry.CallRegistryAlreadySet.selector);
        curators.setCallRegistry(address(0xBEEF));
        vm.prank(alice);
        vm.expectRevert();
        curators.setCallRegistry(address(0xBEEF));
    }

    // ---------------------------------------------------------------- identity links

    function test_linkIdentity_ok() public {
        (address wallet, uint256 pk) = makeAddrAndKey("identity");
        bytes memory sig = _sign(pk, alice, 0);
        vm.prank(alice);
        curators.linkIdentity(wallet, sig);
        assertEq(curators.linkedTo(wallet), alice);
        assertEq(curators.linkedWallets(alice).length, 1);
        assertEq(curators.identityNonce(alice), 1);
    }

    function test_linkIdentity_wrongSignerReverts() public {
        (address wallet,) = makeAddrAndKey("identity");
        (, uint256 otherPk) = makeAddrAndKey("attacker");
        bytes memory sig = _sign(otherPk, alice, 0);
        vm.prank(alice);
        vm.expectRevert(CuratorRegistry.BadSignature.selector);
        curators.linkIdentity(wallet, sig);
    }

    function test_linkIdentity_signatureBoundToCurator() public {
        // a signature made for alice cannot be used by bob to claim the wallet
        _register(bob, "bobby", false);
        (address wallet, uint256 pk) = makeAddrAndKey("identity");
        bytes memory sigForAlice = _sign(pk, alice, 0);
        vm.prank(bob);
        vm.expectRevert(CuratorRegistry.BadSignature.selector);
        curators.linkIdentity(wallet, sigForAlice);
    }

    function test_linkIdentity_replayAfterUnlinkReverts() public {
        (address wallet, uint256 pk) = makeAddrAndKey("identity");
        bytes memory sig = _sign(pk, alice, 0);
        vm.startPrank(alice);
        curators.linkIdentity(wallet, sig);
        curators.unlinkIdentity(wallet);
        vm.expectRevert(CuratorRegistry.BadSignature.selector); // nonce moved on, old sig is dead
        curators.linkIdentity(wallet, sig);
        vm.stopPrank();
        assertEq(curators.linkedTo(wallet), address(0));
    }

    function test_linkIdentity_malleableHighSRejected() public {
        (address wallet, uint256 pk) = makeAddrAndKey("identity");
        bytes memory sig = _sign(pk, alice, 0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        uint256 n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
        bytes memory flipped = abi.encodePacked(r, bytes32(n - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.prank(alice);
        vm.expectRevert(CuratorRegistry.BadSignature.selector);
        curators.linkIdentity(wallet, flipped);
    }

    function test_linkIdentity_walletClaimedOnlyOnce() public {
        _register(bob, "bobby", false);
        (address wallet, uint256 pk) = makeAddrAndKey("identity");
        bytes memory sigA = _sign(pk, alice, 0);
        bytes memory sigB = _sign(pk, bob, 0);
        vm.prank(alice);
        curators.linkIdentity(wallet, sigA);
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(CuratorRegistry.WalletAlreadyLinked.selector, wallet));
        curators.linkIdentity(wallet, sigB);
    }

    function test_linkIdentity_limit() public {
        for (uint256 i = 0; i < 5; i++) {
            (address w, uint256 pk) = makeAddrAndKey(string.concat("w", vm.toString(i)));
            bytes memory s_ = _sign(pk, alice, i);
            vm.prank(alice);
            curators.linkIdentity(w, s_);
        }
        (address w6, uint256 pk6) = makeAddrAndKey("w6");
        bytes memory sig = _sign(pk6, alice, 5);
        vm.prank(alice);
        vm.expectRevert(CuratorRegistry.TooManyLinkedWallets.selector);
        curators.linkIdentity(w6, sig);
    }

    function test_unlink_onlyByOwnerOfLink() public {
        (address wallet, uint256 pk) = makeAddrAndKey("identity");
        bytes memory sigA = _sign(pk, alice, 0);
        vm.prank(alice);
        curators.linkIdentity(wallet, sigA);
        vm.prank(bob);
        vm.expectRevert(CuratorRegistry.WalletNotLinked.selector);
        curators.unlinkIdentity(wallet);
    }

    function test_identityMessage_format() public view {
        string memory m = curators.identityMessage(alice, 7);
        assertTrue(bytes(m).length > 0);
        // contains the registry address and nonce 7, binding the signature to this deployment
        assertTrue(_contains(m, vm.toString(address(curators))) || _contains(m, _lower(address(curators))));
        assertTrue(_contains(m, "nonce:7"));
        assertTrue(_contains(m, "chain:31337"));
    }

    function _lower(address a) internal pure returns (string memory) {
        return _toLower(vm.toString(a));
    }

    function _toLower(string memory s) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] >= 0x41 && b[i] <= 0x5A) b[i] = bytes1(uint8(b[i]) + 32);
        }
        return string(b);
    }

    function _contains(string memory hay, string memory needle) internal pure returns (bool) {
        bytes memory h = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length > h.length) return false;
        for (uint256 i = 0; i <= h.length - n.length; i++) {
            bool ok = true;
            for (uint256 j = 0; j < n.length; j++) {
                if (h[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return true;
        }
        return false;
    }
}
