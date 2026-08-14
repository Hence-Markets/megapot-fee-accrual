// SPDX-License-Identifier: MIT
pragma solidity ^0.8.29;

import {e, euint256, ebool} from "@inco/lightning/src/Lib.sol";

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

interface IJackpot {
    struct DrawingState {
        uint256 prizePool;
        uint256 ticketPrice;
        uint256 edgePerTicket;
        uint256 referralWinShare;
        uint256 referralFee;
        uint256 globalTicketsBought;
        uint256 lpEarnings;
        uint256 drawingTime;
        uint256 winningTicket;
        uint8 ballMax;
        uint8 bonusballMax;
        address payoutCalculator;
        bool jackpotLock;
    }

    function currentDrawingId() external view returns (uint256);
    function getDrawingState(uint256 _drawingId) external view returns (DrawingState memory);
    function ticketPrice() external view returns (uint256);
}

interface IRandomTicketBuyer {
    function buyTickets(
        uint256 _count,
        address _recipient,
        address[] calldata _referrers,
        uint256[] calldata _referralSplit,
        bytes32 _source
    ) external;
}

/// @title SealedCaller — sealed bonusball predictions on Megapot's daily draw
///
/// Every entry does two things at once:
///   1. buys the player a REAL Megapot quick-pick ticket (minted to the player's
///      wallet — non-custodial, this contract never holds tickets or winnings), and
///   2. commits an Inco-encrypted guess at tonight's winning bonusball.
///
/// Guesses stay sealed until Megapot's draw settles, so later entrants can't
/// copy leaders or dodge collisions — that's the fairness the encryption buys.
/// After settlement every guess is revealed and exact hits split the side pot;
/// a round with no hits rolls its pot into the next drawing.
///
/// v0 trust notes (hackathon-honest):
///   - the winning bonusball is posted by the keeper AFTER Megapot's on-chain
///     winningTicket is non-zero; v1 unpacks winningTicket on-chain instead.
///   - Inco Lightning is TEE-attested confidential compute; reveal proofs are
///     covalidator signatures checked via e.verifyDecryption.
contract SealedCaller {
    // ---- immutables ------------------------------------------------------
    IERC20 public immutable usdc;
    IJackpot public immutable jackpot;
    IRandomTicketBuyer public immutable ticketBuyer;
    address public immutable treasury; // Megapot referrer — referral fees recycle into future pots
    address public owner;

    bytes32 public constant SOURCE = keccak256("hence-sealed-caller");
    uint256 public constant CLAIM_WINDOW = 24 hours;

    // ---- per-drawing state ----------------------------------------------
    struct Entry {
        euint256 guess; // sealed bonusball guess
        bool proved; // registered as a winner during the claim window
    }

    struct Round {
        uint256 sidePot; // USDC over ticket price accumulates here
        uint256 settledAt; // 0 = unsettled
        uint8 winningBonusball;
        uint256 winnerCount;
        uint256 payoutPerWinner; // fixed after claim window on first withdraw
        address[] players;
    }

    mapping(uint256 => Round) public rounds; // drawingId => round
    mapping(uint256 => mapping(address => Entry)) internal entries;
    mapping(uint256 => mapping(address => bool)) public withdrawn;
    bool public paused;

    // ---- events ----------------------------------------------------------
    event GuessCommitted(uint256 indexed drawingId, address indexed player, uint256 entryFee);
    event RoundSettled(uint256 indexed drawingId, uint8 winningBonusball, uint256 sidePot, uint256 players);
    event HitProved(uint256 indexed drawingId, address indexed player);
    event Paid(uint256 indexed drawingId, address indexed player, uint256 amount);
    event PotRolled(uint256 indexed fromDrawing, uint256 indexed toDrawing, uint256 amount);

    error Paused();
    error AlreadyEntered();
    error DrawingClosed();
    error NotSettled();
    error AlreadySettled();
    error MegapotNotSettled();
    error BadProof();
    error ClaimWindowOpen();
    error ClaimWindowClosed();
    error NothingToWithdraw();
    error NotOwner();

    constructor(address _usdc, address _jackpot, address _ticketBuyer, address _treasury) {
        usdc = IERC20(_usdc);
        jackpot = IJackpot(_jackpot);
        ticketBuyer = IRandomTicketBuyer(_ticketBuyer);
        treasury = _treasury;
        owner = msg.sender;
    }

    // ---- entry -----------------------------------------------------------

    /// Entry fee is 2x the live ticket price: one ticket to the player, the
    /// rest into the side pot. Price is read from Megapot at call time — never
    /// hardcoded (it is a per-drawing parameter).
    function entryFee() public view returns (uint256) {
        return jackpot.ticketPrice() * 2;
    }

    /// Commit a sealed bonusball guess for the CURRENT drawing and receive a
    /// real Megapot quick-pick minted to msg.sender.
    /// @param ciphertext Inco ciphertext of the guessed bonusball (euint256)
    function commitGuess(bytes calldata ciphertext) external {
        if (paused) revert Paused();
        uint256 drawingId = jackpot.currentDrawingId();
        IJackpot.DrawingState memory s = jackpot.getDrawingState(drawingId);
        if (block.timestamp >= s.drawingTime || s.jackpotLock) revert DrawingClosed();

        Round storage r = rounds[drawingId];
        if (euint256.unwrap(entries[drawingId][msg.sender].guess) != bytes32(0)) revert AlreadyEntered();

        uint256 fee = jackpot.ticketPrice() * 2;
        require(usdc.transferFrom(msg.sender, address(this), fee), "transferFrom failed");

        // one real quick-pick for the player; treasury is the referrer, so
        // Megapot referral fees flow back and can seed future pots
        uint256 price = fee / 2;
        require(usdc.approve(address(ticketBuyer), price), "approve failed");
        address[] memory refs = new address[](1);
        refs[0] = treasury;
        uint256[] memory split = new uint256[](1);
        split[0] = 1e18; // weights must sum to exactly 1e18
        ticketBuyer.buyTickets(1, msg.sender, refs, split, SOURCE);

        r.sidePot += fee - price;
        r.players.push(msg.sender);

        euint256 guess = e.newEuint256(ciphertext, msg.sender);
        e.allow(guess, address(this));
        e.allow(guess, msg.sender);
        entries[drawingId][msg.sender] = Entry({guess: guess, proved: false});

        emit GuessCommitted(drawingId, msg.sender, fee);
    }

    // ---- settlement ------------------------------------------------------

    /// Settle a round after Megapot's draw ran (winningTicket != 0 on-chain).
    /// The keeper posts the winning bonusball; every sealed guess is then
    /// revealed (publicly decryptable) for transparency.
    function settleRound(uint256 drawingId, uint8 winningBonusball) external {
        if (msg.sender != owner) revert NotOwner();
        Round storage r = rounds[drawingId];
        if (r.settledAt != 0) revert AlreadySettled();
        IJackpot.DrawingState memory s = jackpot.getDrawingState(drawingId);
        if (s.winningTicket == 0) revert MegapotNotSettled();

        r.settledAt = block.timestamp;
        r.winningBonusball = winningBonusball;

        address[] storage ps = r.players;
        for (uint256 i = 0; i < ps.length; i++) {
            e.reveal(entries[drawingId][ps[i]].guess);
        }
        emit RoundSettled(drawingId, winningBonusball, r.sidePot, ps.length);
    }

    /// Prove your revealed guess hit the winning bonusball (within the claim
    /// window). `signatures` are Inco covalidator attestations of the plaintext.
    function proveHit(uint256 drawingId, uint256 plainGuess, bytes[] calldata signatures) external {
        Round storage r = rounds[drawingId];
        if (r.settledAt == 0) revert NotSettled();
        if (block.timestamp > r.settledAt + CLAIM_WINDOW) revert ClaimWindowClosed();
        Entry storage en = entries[drawingId][msg.sender];
        if (en.proved) revert AlreadyEntered();
        if (!e.verifyDecryption(en.guess, plainGuess, signatures)) revert BadProof();
        if (plainGuess != r.winningBonusball) revert BadProof();

        en.proved = true;
        r.winnerCount += 1;
        emit HitProved(drawingId, msg.sender);
    }

    /// After the claim window: winners split the pot pro-rata; if nobody hit,
    /// anyone may roll the pot into the current drawing.
    function withdraw(uint256 drawingId) external {
        Round storage r = rounds[drawingId];
        if (r.settledAt == 0) revert NotSettled();
        if (block.timestamp <= r.settledAt + CLAIM_WINDOW) revert ClaimWindowOpen();
        if (r.winnerCount == 0 || !entries[drawingId][msg.sender].proved) revert NothingToWithdraw();
        if (withdrawn[drawingId][msg.sender]) revert NothingToWithdraw();

        if (r.payoutPerWinner == 0) r.payoutPerWinner = r.sidePot / r.winnerCount;
        withdrawn[drawingId][msg.sender] = true;
        require(usdc.transfer(msg.sender, r.payoutPerWinner), "transfer failed");
        emit Paid(drawingId, msg.sender, r.payoutPerWinner);
    }

    function rollPot(uint256 drawingId) external {
        Round storage r = rounds[drawingId];
        if (r.settledAt == 0) revert NotSettled();
        if (block.timestamp <= r.settledAt + CLAIM_WINDOW) revert ClaimWindowOpen();
        if (r.winnerCount != 0) revert NothingToWithdraw();
        uint256 amt = r.sidePot;
        r.sidePot = 0;
        uint256 cur = jackpot.currentDrawingId();
        rounds[cur].sidePot += amt;
        emit PotRolled(drawingId, cur, amt);
    }

    // ---- views / admin ---------------------------------------------------

    function playersOf(uint256 drawingId) external view returns (address[] memory) {
        return rounds[drawingId].players;
    }

    function guessHandleOf(uint256 drawingId, address player) external view returns (bytes32) {
        return euint256.unwrap(entries[drawingId][player].guess);
    }

    function setPaused(bool p) external {
        if (msg.sender != owner) revert NotOwner();
        paused = p;
    }
}
