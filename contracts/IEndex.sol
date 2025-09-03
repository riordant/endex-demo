// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@fhenixprotocol/cofhe-contracts/FHE.sol";

interface IEndex {
    enum Status {
        Open,
        AwaitingSettlement,
        Liquidated,
        Closed
    }

    enum CloseCause {
        UserClose,
        Liquidation,
        TakeProfit,
        StopLoss
    }

    struct Position {
        address owner;
        uint256 positionId;
        bool    isLong;

        // Core economic state
        euint256 size;            // notional in USDC (6 decimals, encrypted)
        uint256  collateral;      // USDC (6 decimals, plaintext)
        uint256  entryPrice;      // Chainlink price (8 decimals, plaintext)

        // Optional plaintext triggers (will move to encrypted later)
        uint256  stopLossPrice;   // price (8 decimals)
        uint256  takeProfitPrice; // price (8 decimals)

        // Lifecycle state
        uint256  settlementPrice; // price (8 decimals) used when AwaitingSettlement
        Status   status;
        CloseCause cause;

        // Funding index snapshot (X18, signed)
        int256 entryFundingX18;

        // Encrypted liquidation trigger workflow
        euint256 pendingLiqFlagEnc; // 0/1 encrypted
        uint256  pendingLiqCheckPrice;
        bool     liqCheckPending;

        // --- NEW: Encrypted price impact (entry-only for now), X18 non-negative buckets ---
        euint256 encImpactEntryGainX18; // trader gain from impact (rare; encrypted, >=0)
        euint256 encImpactEntryLossX18; // trader loss from impact (common; encrypted, >=0)

        // --- NEW: Settlement path B (encrypted equity) ---
        // equityX18 = max(0, collateral*1e18 + gainsX18 - lossesX18)
        // where gains/losses include price, funding, and entry impact.
        euint256 pendingEquityX18; // encrypted equity (X18) awaiting decrypt in _settle
    }

    // --- Events ---
    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        bool isLong,
        euint256 size,
        uint256 collateral,
        uint256 entryPrice
    );

    event PositionClosed(
        uint256 indexed positionId,
        address indexed owner,
        int256 pnl,          // kept for compatibility; 0 when using encrypted equity path
        uint256 payout,      // net payout to user (after fee)
        Status status,       // Closed or Liquidated
        uint256 closePrice,  // settlementPrice used
        uint256 feePaid
    );

    event FundingAccrued(int256 ratePerSecX18, int256 cumLongX18, int256 cumShortX18, uint256 timestamp);
    event EncryptedOIUpdated(bool isLong, bool added, uint256 positionId);
    event FundingRateRequested(uint64 epoch);
    event FundingRateCommitted(int256 newRatePerSecX18, uint64 epoch);
    event PriceImpactApplied(uint256 indexed positionId);

    // --- Trading API ---
    function openPosition(
        bool isLong,
        InEuint256 calldata size_,
        uint256 collateral,
        uint256 stopLossPrice,
        uint256 takeProfitPrice
    ) external;

    function closePosition(uint256 positionId) external;
    function settlePositions(uint256[] calldata positionIds) external;
    function checkPositions(uint256[] calldata positionIds) external;
    function getPosition(uint256 positionId) external view returns (Position memory);

    // --- Funding API ---
    function pokeFunding() external;
    function requestFundingRateFromSkew() external;
    function commitFundingRate(uint64 epoch) external;

    // --- Encrypted liquidation trigger (two-step) ---
    function requestLiqChecks(uint256[] calldata positionIds) external;
    function finalizeLiqChecks(uint256[] calldata positionIds) external;
}
