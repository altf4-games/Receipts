// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

interface ICallRegistryCounts {
    function openCallCount(address curator) external view returns (uint256);
}

/// @notice Who may publish calls. A curator posts a bond, picks a unique handle and declares whether it is a bot.
///         Bot labelling is enforced by handle: "bot:" prefix if and only if `isBot`.
///         The bond is a sybil-cost deposit, NOT slashed in v1 (disclosed).
contract CuratorRegistry is Ownable {
    using SafeERC20 for IERC20;

    uint64 public constant UNBOND_COOLDOWN = 1 days;
    uint256 public constant MAX_LINKED_WALLETS = 5;
    uint256 public constant MIN_HANDLE_LEN = 3;
    uint256 public constant MAX_HANDLE_LEN = 32;

    struct Curator {
        string handle;
        string metadataURI;
        bool isBot;
        bool registered;
        uint128 bond;
        uint64 withdrawAfter; // 0 = not unbonding
    }

    IERC20 public immutable bondToken;
    uint256 public immutable minBond;
    ICallRegistryCounts public callRegistry; // set once

    mapping(address => Curator) private _curators;
    mapping(bytes32 => address) public handleOwner;
    mapping(address => uint256) public identityNonce;
    mapping(address => address[]) private _linked;
    mapping(address => address) public linkedTo; // identity wallet => curator

    event CallRegistrySet(address callRegistry);
    event Registered(address indexed curator, string handle, bool isBot, uint256 bond);
    event BondAdded(address indexed curator, uint256 amount, uint256 newBond);
    event UnbondRequested(address indexed curator, uint64 withdrawAfter);
    event BondWithdrawn(address indexed curator, uint256 amount);
    event MetadataUpdated(address indexed curator, string metadataURI);
    event IdentityLinked(address indexed curator, address indexed wallet, uint256 nonce);
    event IdentityUnlinked(address indexed curator, address indexed wallet);

    error AlreadyRegistered();
    error NotRegistered();
    error BondTooLow(uint256 provided, uint256 required);
    error InvalidHandle();
    error HandleTaken();
    error BotHandleMismatch();
    error CallRegistryAlreadySet();
    error NotUnbonding();
    error CooldownActive(uint64 withdrawAfter);
    error OpenCallsRemain(uint256 count);
    error AlreadyUnbonding();
    error BadSignature();
    error WalletAlreadyLinked(address wallet);
    error TooManyLinkedWallets();
    error WalletNotLinked();

    constructor(address owner_, IERC20 bondToken_, uint256 minBond_) Ownable(owner_) {
        bondToken = bondToken_;
        minBond = minBond_;
    }

    function setCallRegistry(address callRegistry_) external onlyOwner {
        if (address(callRegistry) != address(0)) revert CallRegistryAlreadySet();
        callRegistry = ICallRegistryCounts(callRegistry_);
        emit CallRegistrySet(callRegistry_);
    }

    // ------------------------------------------------------------ registration

    function register(string calldata handle, string calldata metadataURI, bool isBot, uint256 bondAmount) external {
        if (_curators[msg.sender].registered) revert AlreadyRegistered();
        if (bondAmount < minBond) revert BondTooLow(bondAmount, minBond);
        bytes32 key = _validateHandle(handle, isBot);
        if (handleOwner[key] != address(0)) revert HandleTaken();

        handleOwner[key] = msg.sender;
        _curators[msg.sender] = Curator({
            handle: handle,
            metadataURI: metadataURI,
            isBot: isBot,
            registered: true,
            bond: uint128(bondAmount),
            withdrawAfter: 0
        });
        bondToken.safeTransferFrom(msg.sender, address(this), bondAmount);
        emit Registered(msg.sender, handle, isBot, bondAmount);
    }

    function addBond(uint256 amount) external {
        Curator storage c = _curators[msg.sender];
        if (!c.registered) revert NotRegistered();
        if (c.withdrawAfter != 0) revert AlreadyUnbonding();
        c.bond += uint128(amount);
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        emit BondAdded(msg.sender, amount, c.bond);
    }

    /// @notice Start leaving. The curator stops being `isBonded` immediately, so it cannot commit new calls.
    function requestUnbond() external {
        Curator storage c = _curators[msg.sender];
        if (!c.registered) revert NotRegistered();
        if (c.withdrawAfter != 0) revert AlreadyUnbonding();
        c.withdrawAfter = uint64(block.timestamp) + UNBOND_COOLDOWN;
        emit UnbondRequested(msg.sender, c.withdrawAfter);
    }

    /// @notice After the cooldown and with no open calls. The curator may re-bond with `addBond`.
    function withdrawBond() external {
        Curator storage c = _curators[msg.sender];
        if (!c.registered) revert NotRegistered();
        if (c.withdrawAfter == 0) revert NotUnbonding();
        if (block.timestamp < c.withdrawAfter) revert CooldownActive(c.withdrawAfter);
        uint256 open = address(callRegistry) == address(0) ? 0 : callRegistry.openCallCount(msg.sender);
        if (open != 0) revert OpenCallsRemain(open);

        uint256 amount = c.bond;
        c.bond = 0;
        c.withdrawAfter = 0;
        bondToken.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    function setMetadataURI(string calldata metadataURI) external {
        if (!_curators[msg.sender].registered) revert NotRegistered();
        _curators[msg.sender].metadataURI = metadataURI;
        emit MetadataUpdated(msg.sender, metadataURI);
    }

    // ------------------------------------------------------------ identity links (for Nansen)

    /// @notice Message the identity wallet signs (EIP-191 personal_sign). Public so clients build the exact same text.
    function identityMessage(address curator, uint256 nonce) public view returns (string memory) {
        return string.concat(
            "Receipts identity link\ncurator:",
            Strings.toHexString(curator),
            "\nchain:",
            Strings.toString(block.chainid),
            "\nregistry:",
            Strings.toHexString(address(this)),
            "\nnonce:",
            Strings.toString(nonce)
        );
    }

    function linkIdentity(address wallet, bytes calldata signature) external {
        if (!_curators[msg.sender].registered) revert NotRegistered();
        if (linkedTo[wallet] != address(0)) revert WalletAlreadyLinked(wallet);
        if (_linked[msg.sender].length >= MAX_LINKED_WALLETS) revert TooManyLinkedWallets();

        uint256 nonce = identityNonce[msg.sender];
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(bytes(identityMessage(msg.sender, nonce)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || signer != wallet || wallet == address(0)) revert BadSignature();

        identityNonce[msg.sender] = nonce + 1; // a used (or unlinked) signature can never be replayed
        linkedTo[wallet] = msg.sender;
        _linked[msg.sender].push(wallet);
        emit IdentityLinked(msg.sender, wallet, nonce);
    }

    function unlinkIdentity(address wallet) external {
        if (linkedTo[wallet] != msg.sender) revert WalletNotLinked();
        delete linkedTo[wallet];
        address[] storage list = _linked[msg.sender];
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i] == wallet) {
                list[i] = list[list.length - 1];
                list.pop();
                break;
            }
        }
        emit IdentityUnlinked(msg.sender, wallet);
    }

    // ------------------------------------------------------------ views

    function isBonded(address curator) external view returns (bool) {
        Curator storage c = _curators[curator];
        return c.registered && c.withdrawAfter == 0 && c.bond >= minBond;
    }

    function getCurator(address curator) external view returns (Curator memory) {
        return _curators[curator];
    }

    function linkedWallets(address curator) external view returns (address[] memory) {
        return _linked[curator];
    }

    // ------------------------------------------------------------ internals

    /// @dev Handle charset: a-z 0-9 _ - : ; 3..32 chars. Prefix "bot:" required iff isBot.
    function _validateHandle(string calldata handle, bool isBot) internal pure returns (bytes32) {
        bytes calldata h = bytes(handle);
        if (h.length < MIN_HANDLE_LEN || h.length > MAX_HANDLE_LEN) revert InvalidHandle();
        for (uint256 i = 0; i < h.length; i++) {
            bytes1 ch = h[i];
            bool ok = (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) || ch == 0x5f || ch == 0x2d
                || ch == 0x3a;
            if (!ok) revert InvalidHandle();
        }
        bool hasBotPrefix = h.length >= 4 && h[0] == "b" && h[1] == "o" && h[2] == "t" && h[3] == ":";
        if (hasBotPrefix != isBot) revert BotHandleMismatch();
        return keccak256(h);
    }
}
