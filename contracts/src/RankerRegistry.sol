// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title RankerRegistry: open, auditable ranking algorithms
/// @notice Anyone can register a ranker: a name, where its code lives and the exact git commit it was published at.
///         Rankings are computed off chain from public data (the indexer / the registry events); this registry only gives
///         each algorithm a permanent, timestamped receipt, so a feed can say "ranked by ranker #2 at commit <hash>" and
///         anyone can rerun that exact code. Optionally a ranker's author can publish the Merkle root of a ranking it
///         computed as of a block, which gives rankings receipts too.
contract RankerRegistry {
    struct Ranker {
        address author;
        string name;
        string codeURI; // e.g. https://github.com/<owner>/<repo>/tree/<commit>/rankers/src/luckAdjusted.ts
        bytes20 gitCommit; // the commit the code was published at
        uint64 registeredAt;
    }

    uint256 public constant MAX_NAME_LEN = 64;
    uint256 public constant MAX_URI_LEN = 256;

    Ranker[] private _rankers; // id = index + 1
    mapping(bytes32 nameHash => uint256 id) public idByName;

    event RankerRegistered(uint256 indexed rankerId, address indexed author, string name, string codeURI, bytes20 gitCommit);
    event RankingPublished(uint256 indexed rankerId, bytes32 merkleRoot, uint64 asOfBlock, address indexed by);

    error InvalidName();
    error InvalidURI();
    error ZeroCommit();
    error NameTaken(uint256 existingId);
    error UnknownRanker(uint256 rankerId);
    error NotAuthor(address caller, address author);
    error FutureBlock(uint64 asOfBlock);

    function register(string calldata name, string calldata codeURI, bytes20 gitCommit) external returns (uint256 id) {
        if (bytes(name).length == 0 || bytes(name).length > MAX_NAME_LEN) revert InvalidName();
        if (bytes(codeURI).length == 0 || bytes(codeURI).length > MAX_URI_LEN) revert InvalidURI();
        if (gitCommit == bytes20(0)) revert ZeroCommit();
        bytes32 key = keccak256(bytes(name));
        if (idByName[key] != 0) revert NameTaken(idByName[key]);
        _rankers.push(Ranker(msg.sender, name, codeURI, gitCommit, uint64(block.timestamp)));
        id = _rankers.length;
        idByName[key] = id;
        emit RankerRegistered(id, msg.sender, name, codeURI, gitCommit);
    }

    /// @notice The author of a ranker commits to the ranking they computed as of `asOfBlock`.
    function publishRanking(uint256 rankerId, bytes32 merkleRoot, uint64 asOfBlock) external {
        Ranker storage r = _get(rankerId);
        if (msg.sender != r.author) revert NotAuthor(msg.sender, r.author);
        if (asOfBlock > block.number) revert FutureBlock(asOfBlock);
        emit RankingPublished(rankerId, merkleRoot, asOfBlock, msg.sender);
    }

    function rankerCount() external view returns (uint256) {
        return _rankers.length;
    }

    function getRanker(uint256 rankerId) external view returns (Ranker memory) {
        return _get(rankerId);
    }

    function _get(uint256 rankerId) internal view returns (Ranker storage) {
        if (rankerId == 0 || rankerId > _rankers.length) revert UnknownRanker(rankerId);
        return _rankers[rankerId - 1];
    }
}
